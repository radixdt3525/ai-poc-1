import json
import time

import asyncpg

from app.config import settings
from app.pg.pool import pools
from app.pg.serialize import to_json
from app.pg.sqltext import split_statements

# run_id -> (connection id, backend pid) for in-flight user queries
RUNNING: dict[str, tuple[str, int]] = {}


def _error_payload(exc: Exception) -> dict:
    if isinstance(exc, asyncpg.PostgresError):
        return {
            "message": str(exc),
            "sqlstate": getattr(exc, "sqlstate", None),
            "detail": getattr(exc, "detail", None),
            "hint": getattr(exc, "hint", None),
            "position": getattr(exc, "position", None),
        }
    return {"message": str(exc), "sqlstate": None, "detail": None, "hint": None, "position": None}


async def _fetch_limited(stmt: asyncpg.prepared_stmt.PreparedStatement, limit: int):
    cursor = await stmt.cursor()
    rows = await cursor.fetch(limit + 1)
    return rows[:limit], len(rows) > limit


async def _run_one(conn: asyncpg.Connection, sql: str, limit: int) -> dict:
    stmt = await conn.prepare(sql)
    attrs = stmt.get_attributes()
    if not attrs:
        status = await conn.execute(sql)
        return {"sql": sql, "columns": [], "rows": [], "row_count": None, "truncated": False, "status": status}

    # Cursors need a transaction; reuse the user's own if they opened one with BEGIN.
    if conn.is_in_transaction():
        rows, truncated = await _fetch_limited(stmt, limit)
    else:
        async with conn.transaction():
            rows, truncated = await _fetch_limited(stmt, limit)
    return {
        "sql": sql,
        "columns": [{"name": a.name, "type": a.type.name} for a in attrs],
        "rows": [[to_json(v) for v in r] for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
        "status": f"{len(rows)}{'+' if truncated else ''} row(s) returned",
    }


async def execute_script(conn_id: str, sql: str, run_id: str, row_limit: int | None = None) -> dict:
    limit = max(1, min(row_limit or settings.query_row_limit, 100_000))
    statements = split_statements(sql)
    results: list[dict] = []
    notices: list[str] = []
    error: dict | None = None
    started = time.perf_counter()

    pool = await pools.get(conn_id)
    async with pool.acquire() as conn:
        RUNNING[run_id] = (conn_id, conn.get_server_pid())

        def on_notice(_conn, msg):
            notices.append(f"{msg.severity}: {msg.message}")

        conn.add_log_listener(on_notice)
        try:
            await conn.execute(f"SET statement_timeout = {settings.query_timeout_seconds * 1000}")
            for stmt in statements:
                t0 = time.perf_counter()
                try:
                    res = await _run_one(conn, stmt, limit)
                except Exception as exc:
                    error = {**_error_payload(exc), "sql": stmt}
                    break
                res["duration_ms"] = round((time.perf_counter() - t0) * 1000, 2)
                results.append(res)
        finally:
            if conn.is_in_transaction():
                await conn.execute("ROLLBACK")
                notices.append("WARNING: transaction was left open at end of script and has been rolled back")
            conn.remove_log_listener(on_notice)
            RUNNING.pop(run_id, None)

    return {
        "results": results,
        "error": error,
        "notices": notices,
        "statement_count": len(statements),
        "duration_ms": round((time.perf_counter() - started) * 1000, 2),
    }


async def cancel(run_id: str) -> bool:
    entry = RUNNING.get(run_id)
    if entry is None:
        return False
    conn_id, pid = entry
    conn = await pools.direct(conn_id)
    try:
        return bool(await conn.fetchval("SELECT pg_cancel_backend($1)", pid))
    finally:
        await conn.close()


async def explain(conn_id: str, sql: str, analyze: bool = False) -> dict:
    statements = split_statements(sql)
    if len(statements) != 1:
        raise ValueError("EXPLAIN needs exactly one statement")
    stmt = statements[0]
    if stmt.lstrip().upper().startswith("EXPLAIN"):
        raise ValueError("Pass the query without the EXPLAIN keyword")
    options = "ANALYZE, BUFFERS, VERBOSE, FORMAT JSON" if analyze else "VERBOSE, FORMAT JSON"

    pool = await pools.get(conn_id)
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            await conn.execute(f"SET LOCAL statement_timeout = {settings.query_timeout_seconds * 1000}")
            raw = await conn.fetchval(f"EXPLAIN ({options}) {stmt}")
        finally:
            # Always roll back so EXPLAIN ANALYZE of a write has no lasting effect.
            await tx.rollback()
    plan = json.loads(raw) if isinstance(raw, str) else raw
    return {"sql": stmt, "analyze": analyze, "plan": plan}


async def run_readonly(conn_id: str, sql: str, max_rows: int, timeout_s: int) -> dict:
    """Run a query inside a READ ONLY transaction (used by the AI agent)."""
    pool = await pools.get(conn_id)
    async with pool.acquire() as conn:
        async with conn.transaction(readonly=True):
            await conn.execute(f"SET LOCAL statement_timeout = {timeout_s * 1000}")
            stmt = await conn.prepare(sql)
            attrs = stmt.get_attributes()
            if not attrs:
                return {"columns": [], "rows": [], "row_count": 0, "truncated": False}
            rows, truncated = await _fetch_limited(stmt, max_rows)
    return {
        "columns": [a.name for a in attrs],
        "rows": [[to_json(v) for v in r] for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
    }
