import logging
from datetime import UTC, datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from app.config import settings
from app.insights.engine import run_analysis
from app.meta.db import SessionLocal
from app.meta.models import Connection

log = logging.getLogger(__name__)

scheduler = AsyncIOScheduler(timezone="UTC")


async def analyze_all_connections() -> None:
    async with SessionLocal() as session:
        conn_ids = list(await session.scalars(select(Connection.id)))
    for conn_id in conn_ids:
        try:
            summary = await run_analysis(conn_id)
            log.info("insights for %s: %s", conn_id, summary)
        except Exception as exc:
            log.warning("insights for %s failed: %s", conn_id, exc)


def start_scheduler() -> None:
    if settings.insights_interval_minutes <= 0:
        return
    scheduler.add_job(
        analyze_all_connections,
        "interval",
        minutes=settings.insights_interval_minutes,
        next_run_time=datetime.now(UTC) + timedelta(seconds=60),
        max_instances=1,
        coalesce=True,
        id="insights",
    )
    scheduler.start()


def stop_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
