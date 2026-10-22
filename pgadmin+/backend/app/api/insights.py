from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.insights.engine import run_analysis
from app.meta.db import get_session
from app.meta.models import Connection, Insight

router = APIRouter(tags=["insights"])

_SEVERITY_ORDER = case(
    {"high": 0, "medium": 1, "low": 2, "info": 3}, value=Insight.severity, else_=4
)


def _out(i: Insight) -> dict:
    return {
        "id": i.id,
        "check": i.check,
        "severity": i.severity,
        "title": i.title,
        "object_name": i.object_name,
        "details": i.details,
        "explanation": i.explanation,
        "impact": i.impact,
        "fix_sql": i.fix_sql,
        "ai_generated": i.ai_generated,
        "status": i.status,
        "is_read": i.is_read,
        "first_seen": i.first_seen,
        "last_seen": i.last_seen,
    }


@router.get("/connections/{conn_id}/insights")
async def list_insights(conn_id: str, status: str = "open", session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(
        select(Insight)
        .where(Insight.connection_id == conn_id, Insight.status == status)
        .order_by(_SEVERITY_ORDER, Insight.first_seen.desc())
    )
    conn = await session.get(Connection, conn_id)
    unread = await session.scalar(
        select(func.count()).where(
            Insight.connection_id == conn_id, Insight.status == "open", Insight.is_read.is_(False)
        )
    )
    return {
        "items": [_out(i) for i in rows],
        "unread": unread or 0,
        "last_analyzed_at": conn.last_analyzed_at if conn else None,
        "last_analysis_error": conn.last_analysis_error if conn else None,
    }


@router.post("/connections/{conn_id}/insights/analyze")
async def analyze_now(conn_id: str):
    try:
        return await run_analysis(conn_id)
    except Exception as exc:
        raise HTTPException(502, f"Analysis failed: {exc}")


@router.post("/connections/{conn_id}/insights/mark-read")
async def mark_read(conn_id: str, session: AsyncSession = Depends(get_session)):
    await session.execute(update(Insight).where(Insight.connection_id == conn_id).values(is_read=True))
    await session.commit()
    return {"ok": True}


@router.post("/insights/{insight_id}/{action}")
async def set_status(insight_id: str, action: str, session: AsyncSession = Depends(get_session)):
    statuses = {"dismiss": "dismissed", "reopen": "open"}
    if action not in statuses:
        raise HTTPException(404, "Unknown action")
    ins = await session.get(Insight, insight_id)
    if ins is None:
        raise HTTPException(404, "Insight not found")
    ins.status = statuses[action]
    ins.is_read = True
    await session.commit()
    return _out(ins)
