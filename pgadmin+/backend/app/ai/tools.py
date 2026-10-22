"""Read-only tools exposed to the chat agent via OpenAI function calling."""

import json

from app.config import settings
from app.pg import executor, introspect
from app.pg.introspect import qname
from app.pg.safety import is_read_only

_MAX_CELL_CHARS = 300


def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
        },
    }


_SCHEMA = {"type": "string", "description": "Schema name, e.g. public"}
_TABLE = {"type": "string", "description": "Table, view or materialized view name (unquoted)"}

TOOLS = [
    _fn(
        "list_tables",
        "List tables, views, materialized views and functions in a schema, with row estimates and sizes.",
        {"schema": _SCHEMA},
        ["schema"],
    ),
    _fn(
        "describe_table",
        "Columns (types, defaults, nullability), constraints, indexes (with usage counts) and stats for one relation.",
        {"schema": _SCHEMA, "table": _TABLE},
        ["schema", "table"],
    ),
    _fn(
        "get_table_stats",
        "Activity statistics for all user tables: live/dead rows, seq vs index scans, sizes, last vacuum/analyze.",
        {},
        [],
    ),
    _fn(
        "sample_rows",
        "Return up to 20 sample rows from a relation to understand its data.",
        {"schema": _SCHEMA, "table": _TABLE, "limit": {"type": "integer", "description": "1-20"}},
        ["schema", "table", "limit"],
    ),
    _fn(
        "run_readonly_query",
        "Execute a read-only SQL query (SELECT / WITH / SHOW / VALUES) in a READ ONLY transaction with a "
        "short timeout and return up to 50 rows. Use it to answer questions about the data and to validate SQL.",
        {"sql": {"type": "string", "description": "A single read-only SQL statement"}},
        ["sql"],
    ),
    _fn(
        "explain_query",
        "Return the PostgreSQL execution plan (EXPLAIN, not ANALYZE) for a query, to reason about performance.",
        {"sql": {"type": "string", "description": "The query to explain, without the EXPLAIN keyword"}},
        ["sql"],
    ),
]


def _clip(value):
    if isinstance(value, str) and len(value) > _MAX_CELL_CHARS:
        return value[:_MAX_CELL_CHARS] + "..."
    return value


def _clip_rows(rows: list[list]) -> list[list]:
    return [[_clip(v) for v in row] for row in rows]


async def _table_stats(conn_id: str) -> list[dict]:
    return await introspect._fetch(
        conn_id,
        """
        SELECT schemaname AS schema, relname AS table, n_live_tup, n_dead_tup, seq_scan, seq_tup_read,
               idx_scan, pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
               greatest(last_vacuum, last_autovacuum) AS last_vacuum,
               greatest(last_analyze, last_autoanalyze) AS last_analyze
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 100
        """,
    )


async def run_tool(conn_id: str, name: str, args: dict) -> dict:
    max_rows = settings.ai_max_tool_rows
    timeout = settings.ai_query_timeout_seconds

    if name == "list_tables":
        objs = await introspect.list_objects(conn_id, args["schema"])
        return {
            k: [{kk: vv for kk, vv in o.items() if kk != "comment" or vv} for o in v]
            for k, v in objs.items()
            if v
        }
    if name == "describe_table":
        details = await introspect.relation_details(conn_id, args["schema"], args["table"])
        if details is None:
            return {"error": f"relation {args['schema']}.{args['table']} not found"}
        details.pop("ddl", None)
        return details
    if name == "get_table_stats":
        return {"tables": await _table_stats(conn_id)}
    if name == "sample_rows":
        limit = max(1, min(int(args.get("limit") or 10), 20))
        sql = f"SELECT * FROM {qname(args['schema'], args['table'])} LIMIT {limit}"
        res = await executor.run_readonly(conn_id, sql, limit, timeout)
        res["rows"] = _clip_rows(res["rows"])
        return res
    if name == "run_readonly_query":
        sql = args["sql"]
        if not is_read_only(sql):
            return {"error": "Rejected: only read-only statements (SELECT/WITH/SHOW/VALUES/EXPLAIN) are allowed. "
                             "Give the user the SQL to run themselves instead."}
        res = await executor.run_readonly(conn_id, sql, max_rows, timeout)
        res["rows"] = _clip_rows(res["rows"])
        return res
    if name == "explain_query":
        sql = args["sql"].strip().rstrip(";")
        if sql.upper().startswith("EXPLAIN"):
            return {"error": "Pass the query without EXPLAIN"}
        res = await executor.run_readonly(conn_id, f"EXPLAIN {sql}", 500, timeout)
        return {"plan": "\n".join(r[0] for r in res["rows"])}
    return {"error": f"unknown tool {name}"}


async def safe_run_tool(conn_id: str, name: str, raw_args: str) -> dict:
    try:
        args = json.loads(raw_args or "{}")
    except json.JSONDecodeError:
        return {"error": "invalid JSON arguments"}
    try:
        return await run_tool(conn_id, name, args)
    except Exception as exc:  # surface DB errors to the model so it can correct itself
        return {"error": f"{type(exc).__name__}: {exc}"}
