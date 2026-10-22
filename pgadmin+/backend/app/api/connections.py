from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto import encrypt
from app.meta.db import get_session
from app.meta.models import Connection
from app.pg import introspect
from app.pg.pool import ConnParams, connect_once, params_from_model, pools

router = APIRouter(prefix="/connections", tags=["connections"])

SSL_MODES = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}


class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    host: str = Field(min_length=1)
    port: int = 5432
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password: str | None = None  # None on update = keep the stored password
    sslmode: str = "prefer"


class ConnectionTestIn(ConnectionIn):
    id: str | None = None  # use the stored password of this connection if password is None


class ConnectionOut(BaseModel):
    id: str
    name: str
    host: str
    port: int
    database: str
    username: str
    sslmode: str
    has_password: bool
    last_analyzed_at: datetime | None
    last_analysis_error: str | None


def _out(c: Connection) -> ConnectionOut:
    return ConnectionOut(
        id=c.id,
        name=c.name,
        host=c.host,
        port=c.port,
        database=c.database,
        username=c.username,
        sslmode=c.sslmode,
        has_password=bool(c.password_enc),
        last_analyzed_at=c.last_analyzed_at,
        last_analysis_error=c.last_analysis_error,
    )


def _validate(body: ConnectionIn) -> None:
    if body.sslmode not in SSL_MODES:
        raise HTTPException(422, f"sslmode must be one of {sorted(SSL_MODES)}")


async def get_connection_or_404(session: AsyncSession, conn_id: str) -> Connection:
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(404, "Connection not found")
    return conn


@router.get("", response_model=list[ConnectionOut])
async def list_connections(session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(Connection).order_by(Connection.name))
    return [_out(c) for c in rows]


@router.post("", response_model=ConnectionOut)
async def create_connection(body: ConnectionIn, session: AsyncSession = Depends(get_session)):
    _validate(body)
    conn = Connection(
        name=body.name,
        host=body.host,
        port=body.port,
        database=body.database,
        username=body.username,
        password_enc=encrypt(body.password) if body.password else None,
        sslmode=body.sslmode,
    )
    session.add(conn)
    await session.commit()
    return _out(conn)


@router.put("/{conn_id}", response_model=ConnectionOut)
async def update_connection(conn_id: str, body: ConnectionIn, session: AsyncSession = Depends(get_session)):
    _validate(body)
    conn = await get_connection_or_404(session, conn_id)
    for field in ("name", "host", "port", "database", "username", "sslmode"):
        setattr(conn, field, getattr(body, field))
    if body.password is not None:
        conn.password_enc = encrypt(body.password) if body.password else None
    await session.commit()
    await pools.invalidate(conn_id)
    introspect.drop_summary_cache(conn_id)
    return _out(conn)


@router.delete("/{conn_id}")
async def delete_connection(conn_id: str, session: AsyncSession = Depends(get_session)):
    await get_connection_or_404(session, conn_id)
    await session.execute(delete(Connection).where(Connection.id == conn_id))
    await session.commit()
    await pools.invalidate(conn_id)
    introspect.drop_summary_cache(conn_id)
    return {"ok": True}


@router.post("/test")
async def test_connection(body: ConnectionTestIn, session: AsyncSession = Depends(get_session)):
    _validate(body)
    password = body.password
    if password is None and body.id:
        stored = await get_connection_or_404(session, body.id)
        password = params_from_model(stored).password
    params = ConnParams(body.host, body.port, body.database, body.username, password, body.sslmode)
    try:
        conn = await connect_once(params)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    try:
        row = await conn.fetchrow("SELECT version() AS version, current_database() AS db, current_user AS usr")
    finally:
        await conn.close()
    return {"ok": True, "version": row["version"], "database": row["db"], "user": row["usr"]}
