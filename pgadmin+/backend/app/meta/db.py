import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.meta.models import Base

log = logging.getLogger(__name__)

engine = create_async_engine(settings.meta_database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session():
    async with SessionLocal() as session:
        yield session


async def init_db(retries: int = 30) -> None:
    for attempt in range(1, retries + 1):
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            return
        except Exception as exc:  # meta DB may still be starting
            if attempt == retries:
                raise
            log.warning("Meta DB not ready (%s), retrying...", exc)
            await asyncio.sleep(2)


__all__ = ["AsyncSession", "SessionLocal", "engine", "get_session", "init_db"]
