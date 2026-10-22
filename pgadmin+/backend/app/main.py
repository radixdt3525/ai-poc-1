import logging
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api import chat, connections, insights, query, schema
from app.config import settings
from app.crypto import init_crypto
from app.insights.scheduler import start_scheduler, stop_scheduler
from app.meta.db import init_db
from app.pg.pool import ConnectionNotFound, pools

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    await init_crypto()
    start_scheduler()
    yield
    stop_scheduler()
    await pools.close_all()


app = FastAPI(title="pgAdmin+", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")

for module in (connections, schema, query, chat, insights):
    app.include_router(module.router, prefix="/api")


@app.exception_handler(ConnectionNotFound)
async def _conn_not_found(_req: Request, _exc: ConnectionNotFound):
    return JSONResponse(status_code=404, content={"detail": "Connection not found"})


@app.exception_handler(asyncpg.PostgresError)
async def _pg_error(_req: Request, exc: asyncpg.PostgresError):
    return JSONResponse(status_code=400, content={"detail": str(exc), "sqlstate": exc.sqlstate})


@app.exception_handler(OSError)
async def _os_error(_req: Request, exc: OSError):
    # e.g. target database unreachable
    return JSONResponse(status_code=502, content={"detail": f"Cannot reach database: {exc}"})


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/config")
async def config():
    return {
        "ai_enabled": settings.ai_enabled,
        "model": settings.openai_model,
        "insights_interval_minutes": settings.insights_interval_minutes,
        "row_limit": settings.query_row_limit,
    }
