from fastapi import APIRouter, HTTPException

from app.pg import introspect

router = APIRouter(prefix="/connections/{conn_id}", tags=["schema"])


@router.get("/info")
async def info(conn_id: str):
    return await introspect.server_info(conn_id)


@router.get("/schemas")
async def schemas(conn_id: str):
    return await introspect.list_schemas(conn_id)


@router.get("/schemas/{schema}/objects")
async def objects(conn_id: str, schema: str):
    return await introspect.list_objects(conn_id, schema)


@router.get("/relations/{schema}/{name}")
async def relation(conn_id: str, schema: str, name: str):
    details = await introspect.relation_details(conn_id, schema, name)
    if details is None:
        raise HTTPException(404, "Relation not found")
    return details


@router.get("/completion")
async def completion(conn_id: str):
    return await introspect.completion_metadata(conn_id)


@router.post("/refresh")
async def refresh(conn_id: str):
    introspect.drop_summary_cache(conn_id)
    return {"ok": True}
