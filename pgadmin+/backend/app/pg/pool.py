import asyncio
from collections import defaultdict
from dataclasses import dataclass

import asyncpg

from app.crypto import decrypt
from app.meta.db import SessionLocal
from app.meta.models import Connection


class ConnectionNotFound(Exception):
    pass


@dataclass(frozen=True)
class ConnParams:
    host: str
    port: int
    database: str
    username: str
    password: str | None
    sslmode: str

    def connect_kwargs(self) -> dict:
        return {
            "host": self.host,
            "port": self.port,
            "database": self.database,
            "user": self.username,
            "password": self.password,
            "ssl": None if self.sslmode in ("", "disable") else self.sslmode,
            "timeout": 10,
            "statement_cache_size": 0,  # plays nicer with pgbouncer / DDL changes
            "server_settings": {"application_name": "pgadmin-plus"},
        }


def params_from_model(conn: Connection) -> ConnParams:
    return ConnParams(
        host=conn.host,
        port=conn.port,
        database=conn.database,
        username=conn.username,
        password=decrypt(conn.password_enc) if conn.password_enc else None,
        sslmode=conn.sslmode,
    )


async def load_params(conn_id: str) -> ConnParams:
    async with SessionLocal() as session:
        conn = await session.get(Connection, conn_id)
        if conn is None:
            raise ConnectionNotFound(conn_id)
        return params_from_model(conn)


async def connect_once(params: ConnParams) -> asyncpg.Connection:
    return await asyncpg.connect(**params.connect_kwargs())


class PoolManager:
    def __init__(self) -> None:
        self._pools: dict[str, asyncpg.Pool] = {}
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def get(self, conn_id: str) -> asyncpg.Pool:
        pool = self._pools.get(conn_id)
        if pool is not None:
            return pool
        async with self._locks[conn_id]:
            pool = self._pools.get(conn_id)
            if pool is None:
                params = await load_params(conn_id)
                pool = await asyncpg.create_pool(
                    **params.connect_kwargs(),
                    min_size=0,
                    max_size=8,
                    max_inactive_connection_lifetime=300,
                )
                self._pools[conn_id] = pool
            return pool

    async def direct(self, conn_id: str) -> asyncpg.Connection:
        """A dedicated connection outside the pool (used for cancel requests)."""
        return await connect_once(await load_params(conn_id))

    async def invalidate(self, conn_id: str) -> None:
        pool = self._pools.pop(conn_id, None)
        if pool is not None:
            try:
                await asyncio.wait_for(pool.close(), timeout=5)
            except Exception:
                pool.terminate()

    async def close_all(self) -> None:
        for conn_id in list(self._pools):
            await self.invalidate(conn_id)


pools = PoolManager()
