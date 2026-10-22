import json
import time

import asyncpg

from app.pg.pool import pools
from app.pg.serialize import record_to_dict

SYSTEM_SCHEMA_FILTER = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'"

RELKIND_LABELS = {
    "r": "table",
    "p": "partitioned table",
    "v": "view",
    "m": "materialized view",
    "S": "sequence",
    "f": "foreign table",
}


def qident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def qname(schema: str, name: str) -> str:
    return f"{qident(schema)}.{qident(name)}"


async def _fetch(conn_id: str, sql: str, *args) -> list[dict]:
    pool = await pools.get(conn_id)
    async with pool.acquire() as conn:
        return [record_to_dict(r) for r in await conn.fetch(sql, *args)]


async def server_info(conn_id: str) -> dict:
    rows = await _fetch(
        conn_id,
        """
        SELECT version() AS version,
               current_setting('server_version_num')::int AS version_num,
               current_database() AS database,
               current_user AS "user",
               pg_size_pretty(pg_database_size(current_database())) AS size,
               (SELECT coalesce(array_agg(extname ORDER BY extname), '{}') FROM pg_extension) AS extensions
        """,
    )
    return rows[0]


async def list_schemas(conn_id: str) -> list[dict]:
    return await _fetch(
        conn_id,
        f"""
        SELECT n.nspname AS name,
               count(c.oid) FILTER (WHERE c.relkind IN ('r','p') AND NOT c.relispartition) AS tables,
               count(c.oid) FILTER (WHERE c.relkind IN ('v','m')) AS views
        FROM pg_namespace n
        LEFT JOIN pg_class c ON c.relnamespace = n.oid
        WHERE {SYSTEM_SCHEMA_FILTER}
        GROUP BY n.nspname
        ORDER BY n.nspname = 'public' DESC, n.nspname
        """,
    )


async def list_objects(conn_id: str, schema: str) -> dict:
    relations = await _fetch(
        conn_id,
        """
        SELECT c.relname AS name, c.relkind::text AS kind, c.reltuples::bigint AS row_estimate,
               pg_total_relation_size(c.oid) AS total_bytes,
               obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f') AND NOT c.relispartition
        ORDER BY c.relname
        """,
        schema,
    )
    functions = await _fetch(
        conn_id,
        """
        SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
               pg_get_function_result(p.oid) AS result, p.prokind::text AS kind
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY p.proname
        """,
        schema,
    )
    grouped: dict[str, list] = {"tables": [], "views": [], "materialized_views": [], "sequences": [], "foreign_tables": []}
    for r in relations:
        key = {
            "r": "tables",
            "p": "tables",
            "v": "views",
            "m": "materialized_views",
            "S": "sequences",
            "f": "foreign_tables",
        }[r["kind"]]
        grouped[key].append(r)
    grouped["functions"] = functions
    return grouped


async def _relation_oid(conn: asyncpg.Connection, schema: str, name: str) -> int | None:
    return await conn.fetchval(
        """SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2""",
        schema,
        name,
    )


async def relation_details(conn_id: str, schema: str, name: str) -> dict | None:
    pool = await pools.get(conn_id)
    async with pool.acquire() as conn:
        oid = await _relation_oid(conn, schema, name)
        if oid is None:
            return None
        kind = await conn.fetchval("SELECT relkind::text FROM pg_class WHERE oid = $1", oid)
        columns = await conn.fetch(
            """
            SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                   a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default,
                   col_description(a.attrelid, a.attnum) AS comment
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
            """,
            oid,
        )
        constraints = await conn.fetch(
            """SELECT conname AS name, contype::text AS type, pg_get_constraintdef(oid) AS definition
               FROM pg_constraint WHERE conrelid = $1
               ORDER BY array_position(ARRAY['p','u','f','c','x'], contype::text), conname""",
            oid,
        )
        indexes = await conn.fetch(
            """
            SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
                   i.indisunique AS is_unique, i.indisprimary AS is_primary, i.indisvalid AS is_valid,
                   pg_relation_size(i.indexrelid) AS bytes, s.idx_scan AS scans,
                   EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) AS backs_constraint
            FROM pg_index i
            JOIN pg_class ic ON ic.oid = i.indexrelid
            LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
            WHERE i.indrelid = $1
            ORDER BY ic.relname
            """,
            oid,
        )
        stats = await conn.fetchrow(
            """
            SELECT s.n_live_tup, s.n_dead_tup, s.seq_scan, s.idx_scan, s.n_tup_ins, s.n_tup_upd, s.n_tup_del,
                   s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze,
                   pg_size_pretty(pg_total_relation_size($1)) AS total_size,
                   pg_size_pretty(pg_relation_size($1)) AS table_size,
                   pg_size_pretty(pg_indexes_size($1)) AS indexes_size
            FROM (SELECT $1::oid AS relid) x
            LEFT JOIN pg_stat_user_tables s ON s.relid = x.relid
            """,
            oid,
        )
        view_def = None
        if kind in ("v", "m"):
            view_def = await conn.fetchval("SELECT pg_get_viewdef($1, true)", oid)

    details = {
        "schema": schema,
        "name": name,
        "kind": RELKIND_LABELS.get(kind, kind),
        "columns": [record_to_dict(r) for r in columns],
        "constraints": [record_to_dict(r) for r in constraints],
        "indexes": [record_to_dict(r) for r in indexes],
        "stats": record_to_dict(stats) if stats else {},
        "view_definition": view_def,
    }
    details["ddl"] = build_ddl(details)
    return details


def build_ddl(d: dict) -> str:
    target = qname(d["schema"], d["name"])
    if d["view_definition"] is not None:
        mat = "MATERIALIZED " if d["kind"] == "materialized view" else ""
        return f"CREATE {mat}VIEW {target} AS\n{d['view_definition'].rstrip().rstrip(';')};"
    lines = []
    for c in d["columns"]:
        line = f"    {qident(c['name'])} {c['type']}"
        if c["default"] is not None:
            line += f" DEFAULT {c['default']}"
        if c["not_null"]:
            line += " NOT NULL"
        lines.append(line)
    for con in d["constraints"]:
        if con["type"] in ("p", "u", "f", "c", "x"):
            lines.append(f"    CONSTRAINT {qident(con['name'])} {con['definition']}")
    ddl = f"CREATE TABLE {target} (\n" + ",\n".join(lines) + "\n);"
    extra = [f"{i['definition']};" for i in d["indexes"] if not i["backs_constraint"]]
    if extra:
        ddl += "\n\n" + "\n".join(extra)
    return ddl


async def completion_metadata(conn_id: str) -> list[dict]:
    return await _fetch(
        conn_id,
        f"""
        SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
               array_agg(a.attname::text ORDER BY a.attnum) AS columns
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r','p','v','m','f') AND {SYSTEM_SCHEMA_FILTER}
        GROUP BY n.nspname, c.relname, c.relkind
        ORDER BY n.nspname, c.relname
        LIMIT 3000
        """,
    )


# ---- compact schema summary for the LLM -------------------------------------------------

_summary_cache: dict[str, tuple[float, str]] = {}
_SUMMARY_TTL = 120
_SUMMARY_MAX_CHARS = 16000


async def schema_summary(conn_id: str, fresh: bool = False) -> str:
    cached = _summary_cache.get(conn_id)
    if cached and not fresh and time.time() - cached[0] < _SUMMARY_TTL:
        return cached[1]

    info = await server_info(conn_id)
    tables = await _fetch(
        conn_id,
        f"""
        SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
               greatest(c.reltuples, 0)::bigint AS rows,
               json_agg(json_build_object('n', a.attname, 't', format_type(a.atttypid, a.atttypmod),
                                          'nn', a.attnotnull) ORDER BY a.attnum) AS cols
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND {SYSTEM_SCHEMA_FILTER}
        GROUP BY c.oid, n.nspname, c.relname, c.relkind
        ORDER BY n.nspname, c.relname
        """,
    )
    constraints = await _fetch(
        conn_id,
        f"""
        SELECT n.nspname AS schema, c.relname AS name, con.contype::text AS type,
               pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype IN ('p','f','u') AND {SYSTEM_SCHEMA_FILTER}
        """,
    )
    cons_by_table: dict[tuple, list[str]] = {}
    for con in constraints:
        cons_by_table.setdefault((con["schema"], con["name"]), []).append(con["def"])

    header = (
        f"Server: {info['version'].split(',')[0]}\n"
        f"Database: {info['database']} ({info['size']}), connected as {info['user']}\n"
        f"Extensions: {', '.join(info['extensions']) or 'none'}\n"
    )
    lines: list[str] = []
    short_lines: list[str] = []
    for t in tables:
        cols = json.loads(t["cols"]) if isinstance(t["cols"], str) else t["cols"]
        kind = RELKIND_LABELS.get(t["kind"], t["kind"])
        label = f"{t['schema']}.{t['name']}"
        col_txt = ", ".join(f"{c['n']} {c['t']}{' NOT NULL' if c['nn'] else ''}" for c in cols)
        line = f"- {label} [{kind}, ~{t['rows']} rows]: {col_txt}"
        cons = cons_by_table.get((t["schema"], t["name"]))
        if cons:
            line += " | " + "; ".join(cons)
        lines.append(line)
        short_lines.append(f"- {label} [{kind}, ~{t['rows']} rows]")

    body = "\n".join(lines)
    if len(body) > _SUMMARY_MAX_CHARS:
        body = "\n".join(short_lines)
        if len(body) > _SUMMARY_MAX_CHARS:
            body = body[:_SUMMARY_MAX_CHARS] + "\n... (truncated)"
        body = "(Column details omitted because the schema is large; use describe_table.)\n" + body
    summary = header + "Relations:\n" + (body or "(no user tables)")
    _summary_cache[conn_id] = (time.time(), summary)
    return summary


def drop_summary_cache(conn_id: str) -> None:
    _summary_cache.pop(conn_id, None)
