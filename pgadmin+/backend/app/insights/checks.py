"""Rule-based database health checks. Each check returns a list of Findings."""

import logging
from dataclasses import dataclass, field

import asyncpg

from app.pg.introspect import qident, qname
from app.pg.serialize import record_to_dict

log = logging.getLogger(__name__)

SCHEMA_FILTER = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'"


@dataclass
class Finding:
    check: str
    severity: str  # high | medium | low | info
    title: str
    object_name: str | None
    explanation: str
    fix_sql: str | None = None
    details: dict = field(default_factory=dict)
    # Only surface the finding once it has persisted this long (avoids flagging just-created objects).
    confirm_after_hours: float = 0

    @property
    def fingerprint(self) -> str:
        return f"{self.check}:{self.object_name or ''}"


async def fk_without_index(conn: asyncpg.Connection) -> list[Finding]:
    rows = await conn.fetch(
        f"""
        SELECT n.nspname AS schema, cl.relname AS table, c.conname AS constraint,
               array_agg(a.attname::text ORDER BY x.ord) AS columns,
               cl.reltuples::bigint AS rows, c.confrelid::regclass::text AS references
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum
        WHERE c.contype = 'f' AND {SCHEMA_FILTER}
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)] @> c.conkey
              AND (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)] <@ c.conkey
          )
        GROUP BY n.nspname, cl.relname, c.conname, cl.reltuples, c.confrelid
        """
    )
    out = []
    for r in rows:
        cols = ", ".join(qident(c) for c in r["columns"])
        idx_name = qident(f"idx_{r['table']}_{'_'.join(r['columns'])}"[:63])
        out.append(
            Finding(
                check="fk_missing_index",
                severity="high" if r["rows"] > 100_000 else "medium",
                title=f"Foreign key {r['constraint']} on {r['schema']}.{r['table']}({', '.join(r['columns'])}) has no index",
                object_name=f"{r['schema']}.{r['table']}.{r['constraint']}",
                explanation="Joins on this foreign key and deletes/updates of the referenced rows must scan the "
                            "whole referencing table without an index.",
                fix_sql=f"CREATE INDEX CONCURRENTLY {idx_name} ON {qname(r['schema'], r['table'])} ({cols});",
                details=record_to_dict(r),
            )
        )
    return out


async def unused_indexes(conn: asyncpg.Connection) -> list[Finding]:
    rows = await conn.fetch(
        """
        SELECT s.schemaname AS schema, s.relname AS table, s.indexrelname AS index,
               pg_relation_size(s.indexrelid) AS bytes, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
               t.seq_scan + coalesce(t.idx_scan, 0) AS table_scans
        FROM pg_stat_user_indexes s
        JOIN pg_index i ON i.indexrelid = s.indexrelid
        JOIN pg_stat_user_tables t ON t.relid = s.relid
        WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
          AND t.seq_scan + coalesce(t.idx_scan, 0) > 100
        """
    )
    return [
        Finding(
            check="unused_index",
            severity="low",
            title=f"Index {r['schema']}.{r['index']} has never been used ({r['size']})",
            object_name=f"{r['schema']}.{r['index']}",
            explanation="The table is queried regularly but this index has zero scans since statistics were last "
                        "reset. It costs disk space and slows down writes.",
            fix_sql=f"-- Verify on replicas / after a full business cycle before dropping\n"
                    f"DROP INDEX CONCURRENTLY IF EXISTS {qname(r['schema'], r['index'])};",
            details=record_to_dict(r),
            confirm_after_hours=24,
        )
        for r in rows
    ]


async def duplicate_indexes(conn: asyncpg.Connection) -> list[Finding]:
    rows = await conn.fetch(
        f"""
        SELECT n.nspname AS schema, t.relname AS table,
               array_agg(ic.relname::text ORDER BY i.indisprimary DESC, i.indisunique DESC, ic.relname) AS indexes,
               pg_size_pretty(sum(pg_relation_size(i.indexrelid))::bigint) AS total_size
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE {SCHEMA_FILTER}
        GROUP BY n.nspname, t.relname, i.indrelid, i.indkey::text, i.indclass::text, ic.relam,
                 coalesce(pg_get_expr(i.indexprs, i.indrelid), ''), coalesce(pg_get_expr(i.indpred, i.indrelid), '')
        HAVING count(*) > 1
        """
    )
    out = []
    for r in rows:
        keep, *drops = r["indexes"]
        out.append(
            Finding(
                check="duplicate_index",
                severity="medium",
                title=f"Duplicate indexes on {r['schema']}.{r['table']}: {', '.join(r['indexes'])}",
                object_name=f"{r['schema']}.{r['table']}:{','.join(r['indexes'])}",
                explanation=f"These indexes have identical definitions. Keep {keep} and drop the rest to save space "
                            "and write overhead.",
                fix_sql="\n".join(
                    f"DROP INDEX CONCURRENTLY IF EXISTS {qname(r['schema'], d)};" for d in drops
                ) + "\n-- If a dropped index backs a constraint, drop the constraint instead.",
                details=record_to_dict(r),
            )
        )
    return out


async def redundant_indexes(conn: asyncpg.Connection) -> list[Finding]:
    rows = await conn.fetch(
        f"""
        WITH idx AS (
            SELECT i.indexrelid, i.indrelid, i.indisunique, i.indisprimary, ic.relam,
                   string_to_array(i.indkey::text, ' ') AS cols, ic.relname AS name
            FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
            WHERE i.indexprs IS NULL AND i.indpred IS NULL
        )
        SELECT n.nspname AS schema, t.relname AS table, a.name AS redundant, b.name AS covered_by,
               pg_size_pretty(pg_relation_size(a.indexrelid)) AS size
        FROM idx a
        JOIN idx b ON a.indrelid = b.indrelid AND a.indexrelid <> b.indexrelid AND a.relam = b.relam
        JOIN pg_class t ON t.oid = a.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE NOT a.indisunique AND NOT a.indisprimary
          AND array_length(a.cols, 1) < array_length(b.cols, 1)
          AND b.cols[1:array_length(a.cols, 1)] = a.cols
          AND {SCHEMA_FILTER}
        """
    )
    return [
        Finding(
            check="redundant_index",
            severity="low",
            title=f"Index {r['schema']}.{r['redundant']} is a prefix of {r['covered_by']}",
            object_name=f"{r['schema']}.{r['redundant']}",
            explanation=f"{r['covered_by']} starts with the same columns, so it can serve the same lookups. "
                        f"{r['redundant']} ({r['size']}) is likely redundant.",
            fix_sql=f"DROP INDEX CONCURRENTLY IF EXISTS {qname(r['schema'], r['redundant'])};",
            details=record_to_dict(r),
        )
        for r in rows
    ]


async def invalid_indexes(conn: asyncpg.Connection) -> list[Finding]:
    rows = await conn.fetch(
        f"""
        SELECT n.nspname AS schema, ic.relname AS index, t.relname AS table
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = ic.relnamespace
        WHERE NOT i.indisvalid AND {SCHEMA_FILTER}
        """
    )
    return [
        Finding(
            check="invalid_index",
            severity="high",
            title=f"Index {r['schema']}.{r['index']} is INVALID",
            object_name=f"{r['schema']}.{r['index']}",
            explanation="An invalid index (usually from a failed CREATE INDEX CONCURRENTLY) is not used by queries "
                        "but is still maintained on every write.",
            fix_sql=f"REINDEX INDEX CONCURRENTLY {qname(r['schema'], r['index'])};",
            details=record_to_dict(r),
        )
        for r in rows
    ]


async def tables_without_pk(conn: asyncpg.Connection) -> list[Finding]:
    rows = await conn.fetch(
        f"""
        SELECT n.nspname AS schema, c.relname AS table, greatest(c.reltuples, 0)::bigint AS rows
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND {SCHEMA_FILTER}
          AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
        """
    )
    return [
        Finding(
            check="no_primary_key",
            severity="medium",
            title=f"Table {r['schema']}.{r['table']} has no primary key",
            object_name=f"{r['schema']}.{r['table']}",
            explanation="Without a primary key rows can't be reliably identified; it blocks logical replication "
                        "of UPDATE/DELETE and invites duplicate data.",
            fix_sql=f"-- Option: add a surrogate key\nALTER TABLE {qname(r['schema'], r['table'])} "
                    f"ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;",
            details=record_to_dict(r),
        )
        for r in rows
    ]


async def vacuum_health(conn: asyncpg.Connection) -> list[Finding]:
    rows = await conn.fetch(
        """
        SELECT schemaname AS schema, relname AS table, n_live_tup, n_dead_tup,
               round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_pct,
               greatest(last_vacuum, last_autovacuum) AS last_vacuum,
               greatest(last_analyze, last_autoanalyze) AS last_analyze
        FROM pg_stat_user_tables
        """
    )
    out = []
    for r in rows:
        target = qname(r["schema"], r["table"])
        if r["n_dead_tup"] > 1000 and r["dead_pct"] > 20:
            out.append(
                Finding(
                    check="dead_tuples",
                    severity="high" if r["dead_pct"] > 50 else "medium",
                    title=f"{r['schema']}.{r['table']} has {r['dead_pct']}% dead rows ({r['n_dead_tup']})",
                    object_name=f"{r['schema']}.{r['table']}",
                    explanation="Dead tuples bloat the table and indexes and slow down scans. Autovacuum may be "
                                "falling behind for this table.",
                    fix_sql=f"VACUUM (ANALYZE, VERBOSE) {target};",
                    details=record_to_dict(r),
                )
            )
        if r["last_analyze"] is None and r["n_live_tup"] > 1000:
            out.append(
                Finding(
                    check="never_analyzed",
                    severity="low",
                    title=f"{r['schema']}.{r['table']} has never been analyzed",
                    object_name=f"{r['schema']}.{r['table']}",
                    explanation="The planner has no statistics for this table and may choose poor query plans.",
                    fix_sql=f"ANALYZE {target};",
                    details=record_to_dict(r),
                )
            )
    return out


async def seq_scan_heavy(conn: asyncpg.Connection) -> list[Finding]:
    rows = await conn.fetch(
        """
        SELECT schemaname AS schema, relname AS table, seq_scan, seq_tup_read, coalesce(idx_scan, 0) AS idx_scan,
               n_live_tup, seq_tup_read / greatest(seq_scan, 1) AS avg_rows_per_seq_scan
        FROM pg_stat_user_tables
        WHERE seq_scan > 50 AND n_live_tup > 10000 AND seq_scan > coalesce(idx_scan, 0)
          AND seq_tup_read / greatest(seq_scan, 1) > 5000
        ORDER BY seq_tup_read DESC
        LIMIT 20
        """
    )
    return [
        Finding(
            check="seq_scan_heavy",
            severity="high" if r["n_live_tup"] > 100_000 else "medium",
            title=f"{r['schema']}.{r['table']} is mostly read by sequential scans ({r['seq_scan']} seq vs "
                  f"{r['idx_scan']} index scans)",
            object_name=f"{r['schema']}.{r['table']}",
            explanation="Large table read mainly by full scans; queries filtering on unindexed columns may need "
                        "an index.",
            details=record_to_dict(r),
        )
        for r in rows
    ]


async def slow_queries(conn: asyncpg.Connection) -> list[Finding]:
    has_ext = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')")
    if not has_ext:
        return [
            Finding(
                check="pg_stat_statements_missing",
                severity="info",
                title="pg_stat_statements is not enabled",
                object_name=None,
                explanation="Enable pg_stat_statements so slow-query analysis can find your most expensive queries. "
                            "It must be listed in shared_preload_libraries (requires a restart) and then created "
                            "as an extension.",
                fix_sql="-- postgresql.conf: shared_preload_libraries = 'pg_stat_statements' (then restart)\n"
                        "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
            )
        ]
    version = await conn.fetchval("SELECT current_setting('server_version_num')::int")
    mean_col, total_col = ("mean_exec_time", "total_exec_time") if version >= 130000 else ("mean_time", "total_time")
    try:
        rows = await conn.fetch(
            f"""
            SELECT queryid::text AS queryid, left(query, 2000) AS query, calls,
                   round({mean_col}::numeric, 2) AS mean_ms, round({total_col}::numeric, 2) AS total_ms, rows
            FROM pg_stat_statements
            WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND calls >= 5 AND {mean_col} > 100
              AND query !~* '^\\s*(BEGIN|COMMIT|ROLLBACK|SET|SHOW|VACUUM|ANALYZE|CREATE|ALTER|DROP)'
            ORDER BY {total_col} DESC
            LIMIT 5
            """
        )
    except asyncpg.PostgresError as exc:
        log.info("pg_stat_statements unavailable: %s", exc)
        return []
    return [
        Finding(
            check="slow_query",
            severity="high" if r["mean_ms"] > 1000 else "medium",
            title=f"Slow query: {r['mean_ms']} ms avg over {r['calls']} calls",
            object_name=r["queryid"],
            explanation="One of the most expensive queries on this database by total execution time.",
            details=record_to_dict(r),
        )
        for r in rows
    ]


async def cache_hit_ratio(conn: asyncpg.Connection) -> list[Finding]:
    r = await conn.fetchrow(
        """
        SELECT blks_hit, blks_read,
               round(100.0 * blks_hit / greatest(blks_hit + blks_read, 1), 2) AS hit_pct,
               current_setting('shared_buffers') AS shared_buffers
        FROM pg_stat_database WHERE datname = current_database()
        """
    )
    if r is None or r["blks_hit"] + r["blks_read"] < 100_000 or r["hit_pct"] >= 95:
        return []
    return [
        Finding(
            check="low_cache_hit",
            severity="medium",
            title=f"Buffer cache hit ratio is {r['hit_pct']}%",
            object_name=None,
            explanation=f"Less than 95% of reads are served from shared_buffers ({r['shared_buffers']}). The working "
                        "set may not fit in memory, or queries are scanning more data than necessary.",
            details=record_to_dict(r),
        )
    ]


ALL_CHECKS = [
    fk_without_index,
    unused_indexes,
    duplicate_indexes,
    redundant_indexes,
    invalid_indexes,
    tables_without_pk,
    vacuum_health,
    seq_scan_heavy,
    slow_queries,
    cache_hit_ratio,
]


async def run_all_checks(conn: asyncpg.Connection) -> tuple[list[Finding], list[str]]:
    findings: list[Finding] = []
    errors: list[str] = []
    for check in ALL_CHECKS:
        try:
            findings += await check(conn)
        except Exception as exc:
            log.warning("check %s failed: %s", check.__name__, exc)
            errors.append(f"{check.__name__}: {exc}")
    return findings, errors
