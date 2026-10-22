import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.meta.db import SessionLocal, get_session
from app.meta.models import QueryHistory
from app.pg import executor, introspect
from app.pg.safety import DESTRUCTIVE, WRITE, classify_script

router = APIRouter(prefix="/connections/{conn_id}", tags=["query"])


class QueryIn(BaseModel):
    sql: str
    run_id: str | None = None
    row_limit: int | None = None
    confirm_destructive: bool = False


class ExplainIn(BaseModel):
    sql: str
    analyze: bool = False


class CancelIn(BaseModel):
    run_id: str


@router.post("/query")
async def run_query(conn_id: str, body: QueryIn):
    classified = classify_script(body.sql)
    if not classified:
        raise HTTPException(400, "No SQL statements to run")
    destructive = [
        {"sql": stmt[:500], "reason": c.reason} for stmt, c in classified if c.kind == DESTRUCTIVE
    ]
    if destructive and not body.confirm_destructive:
        return JSONResponse(
            status_code=409,
            content={"requires_confirmation": True, "statements": destructive},
        )

    result = await executor.execute_script(conn_id, body.sql, body.run_id or uuid.uuid4().hex, body.row_limit)

    # Schema may have changed: drop the cached AI summary after any write.
    if any(c.kind in (WRITE, DESTRUCTIVE) for _, c in classified):
        introspect.drop_summary_cache(conn_id)
        result["schema_changed"] = True

    err = result["error"]
    rows = sum(r["row_count"] or 0 for r in result["results"])
    async with SessionLocal() as session:
        session.add(
            QueryHistory(
                connection_id=conn_id,
                sql=body.sql[:20000],
                status="error" if err else "ok",
                duration_ms=result["duration_ms"],
                row_count=rows,
                error=err["message"] if err else None,
            )
        )
        await session.commit()
    return result


@router.post("/query/cancel")
async def cancel_query(conn_id: str, body: CancelIn):
    return {"cancelled": await executor.cancel(body.run_id)}


@router.post("/explain")
async def explain(conn_id: str, body: ExplainIn):
    try:
        return await executor.explain(conn_id, body.sql, body.analyze)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get("/history")
async def history(conn_id: str, limit: int = 100, session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(
        select(QueryHistory)
        .where(QueryHistory.connection_id == conn_id)
        .order_by(QueryHistory.id.desc())
        .limit(min(limit, 500))
    )
    return [
        {
            "id": r.id,
            "sql": r.sql,
            "status": r.status,
            "duration_ms": r.duration_ms,
            "row_count": r.row_count,
            "error": r.error,
            "created_at": r.created_at,
        }
        for r in rows
    ]
