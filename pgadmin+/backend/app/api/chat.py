import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.agent import run_chat
from app.ai.client import AIUnavailable
from app.meta.db import SessionLocal, get_session
from app.meta.models import ChatMessage, ChatSession

log = logging.getLogger(__name__)
router = APIRouter(tags=["chat"])


class SessionIn(BaseModel):
    title: str | None = None


class MessageIn(BaseModel):
    message: str
    editor_sql: str | None = None
    editor_error: str | None = None


def _session_out(s: ChatSession) -> dict:
    return {"id": s.id, "connection_id": s.connection_id, "title": s.title,
            "created_at": s.created_at, "updated_at": s.updated_at}


@router.get("/connections/{conn_id}/chat/sessions")
async def list_sessions(conn_id: str, session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(
        select(ChatSession).where(ChatSession.connection_id == conn_id).order_by(ChatSession.updated_at.desc())
    )
    return [_session_out(s) for s in rows]


@router.post("/connections/{conn_id}/chat/sessions")
async def create_session(conn_id: str, body: SessionIn, session: AsyncSession = Depends(get_session)):
    s = ChatSession(connection_id=conn_id, title=body.title or "New chat")
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return _session_out(s)


@router.delete("/chat/sessions/{session_id}")
async def delete_session(session_id: str, session: AsyncSession = Depends(get_session)):
    await session.execute(delete(ChatSession).where(ChatSession.id == session_id))
    await session.commit()
    return {"ok": True}


@router.get("/chat/sessions/{session_id}/messages")
async def list_messages(session_id: str, session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(
        select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.id)
    )
    return [
        {"id": m.id, "role": m.role, "content": m.content, "steps": m.steps, "created_at": m.created_at}
        for m in rows
    ]


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, default=str)}\n\n"


@router.post("/chat/sessions/{session_id}/stream")
async def stream_message(session_id: str, body: MessageIn):
    async with SessionLocal() as db:
        chat = await db.get(ChatSession, session_id)
        if chat is None:
            raise HTTPException(404, "Chat session not found")
        conn_id = chat.connection_id
        prior = await db.scalars(
            select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.id)
        )
        history = [{"role": m.role, "content": m.content} for m in prior if m.content]
        db.add(ChatMessage(session_id=session_id, role="user", content=body.message))
        if chat.title == "New chat":
            chat.title = body.message.strip().splitlines()[0][:80] or "New chat"
        await db.commit()

    async def events():
        final: dict | None = None
        partial: list[str] = []
        try:
            async for ev in run_chat(conn_id, history, body.message, body.editor_sql, body.editor_error):
                if ev["type"] == "done":
                    final = ev
                elif ev["type"] == "token":
                    partial.append(ev["content"])
                yield _sse(ev)
        except AIUnavailable as exc:
            yield _sse({"type": "error", "message": str(exc)})
        except Exception as exc:
            log.exception("chat failed")
            yield _sse({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        finally:
            content = final["content"] if final else "".join(partial)
            steps = final["steps"] if final else None
            if content or steps:
                async with SessionLocal() as db:
                    db.add(ChatMessage(session_id=session_id, role="assistant", content=content, steps=steps))
                    chat = await db.get(ChatSession, session_id)
                    if chat:
                        chat.title = chat.title  # touch updated_at
                    await db.commit()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
