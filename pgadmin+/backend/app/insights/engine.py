import asyncio
import json
import logging
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.ai.client import get_client
from app.ai.prompts import INSIGHTS_SYSTEM_PROMPT
from app.config import settings
from app.insights.checks import Finding, run_all_checks
from app.meta.db import SessionLocal
from app.meta.models import Connection, Insight
from app.pg.introspect import schema_summary
from app.pg.pool import pools

log = logging.getLogger(__name__)

_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
_AI_BATCH = 20


async def _enrich_with_ai(conn_id: str, insights: list[Insight]) -> None:
    client = get_client()
    summary = (await schema_summary(conn_id))[:12000]
    system = INSIGHTS_SYSTEM_PROMPT.replace("{schema_summary}", summary)
    for start in range(0, len(insights), _AI_BATCH):
        batch = insights[start:start + _AI_BATCH]
        payload = [
            {
                "id": i.id,
                "check": i.check,
                "severity": i.severity,
                "title": i.title,
                "details": i.details,
                "rule_based_fix": i.fix_sql or "",
            }
            for i in batch
        ]
        resp = await client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps({"findings": payload}, default=str)},
            ],
        )
        items = json.loads(resp.choices[0].message.content or "{}").get("items", [])
        by_id = {i.id: i for i in batch}
        for item in items:
            ins = by_id.get(item.get("id"))
            if ins is None:
                continue
            ins.explanation = item.get("explanation") or ins.explanation
            ins.impact = item.get("impact") or ins.impact
            if item.get("fix_sql"):
                ins.fix_sql = item["fix_sql"]
            ins.ai_generated = True


async def run_analysis(conn_id: str, use_ai: bool = True) -> dict:
    """Run all checks for a connection and upsert insights. Returns a short summary."""
    async with _locks[conn_id]:
        now = datetime.now(UTC)
        error: str | None = None
        findings: list[Finding] = []
        try:
            pool = await pools.get(conn_id)
            async with pool.acquire() as conn:
                findings, check_errors = await run_all_checks(conn)
            if check_errors:
                error = "; ".join(check_errors)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            async with SessionLocal() as session:
                conn_row = await session.get(Connection, conn_id)
                if conn_row:
                    conn_row.last_analyzed_at = now
                    conn_row.last_analysis_error = error
                    await session.commit()
            raise

        async with SessionLocal() as session:
            existing = {
                i.fingerprint: i
                for i in (await session.scalars(select(Insight).where(Insight.connection_id == conn_id))).all()
            }
            seen: set[str] = set()
            new: list[Insight] = []
            visible = 0
            for f in findings:
                fp = f.fingerprint
                if fp in seen:
                    continue
                seen.add(fp)
                ins = existing.get(fp)
                if ins is not None:
                    ins.details = f.details
                    ins.severity = f.severity
                    ins.title = f.title
                    ins.last_seen = now
                    if ins.status == "resolved":
                        ins.status, ins.is_read = "open", False
                    elif ins.status == "pending" and now - ins.first_seen >= timedelta(hours=f.confirm_after_hours):
                        ins.status, ins.is_read = "open", False
                        new.append(ins)
                else:
                    pending = f.confirm_after_hours > 0
                    ins = Insight(
                        connection_id=conn_id,
                        fingerprint=fp,
                        check=f.check,
                        severity=f.severity,
                        title=f.title,
                        object_name=f.object_name,
                        details=f.details,
                        explanation=f.explanation,
                        fix_sql=f.fix_sql,
                        status="pending" if pending else "open",
                        is_read=pending,
                        first_seen=now,
                        last_seen=now,
                    )
                    session.add(ins)
                    if not pending:
                        new.append(ins)
                if ins.status != "pending":
                    visible += 1
            resolved = 0
            for fp, ins in existing.items():
                if fp in seen:
                    continue
                if ins.status == "open":
                    ins.status = "resolved"
                    resolved += 1
                elif ins.status == "pending":
                    await session.delete(ins)
            await session.flush()

            if new and use_ai and settings.ai_enabled:
                try:
                    await _enrich_with_ai(conn_id, new)
                except Exception as exc:
                    log.warning("AI enrichment failed: %s", exc)
                    error = (error + "; " if error else "") + f"AI enrichment failed: {exc}"

            conn_row = await session.get(Connection, conn_id)
            if conn_row:
                conn_row.last_analyzed_at = now
                conn_row.last_analysis_error = error
            await session.commit()

    return {"findings": visible, "new": len(new), "resolved": resolved, "error": error}
