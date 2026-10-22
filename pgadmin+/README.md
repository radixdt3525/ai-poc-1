# pgAdmin+

A web-based PostgreSQL SQL editor in the spirit of pgAdmin, with an AI assistant that knows your database.

- **SQL editor**: Monaco editor (the VS Code editor) with multiple tabs, PostgreSQL highlighting, and schema-aware autocomplete (tables, columns, aliases). Run a selection or the whole script, cancel a running query, format SQL, EXPLAIN / EXPLAIN ANALYZE with a visual plan, and query history.
- **Schema browser**: schemas, tables, views, materialized views, sequences, functions, columns, indexes (with usage counts) and constraints. Right from the tree you can run "SELECT top 100", generate a CREATE script, or ask the AI about a table.
- **Results grid**: virtualized grid for large result sets, multiple result sets per script, a messages and notices tab, and CSV copy or download.
- **AI chat**: ask in natural language. The assistant inspects your live schema, statistics and data through read-only tools, answers the question, and writes SQL. You can insert that SQL into the editor or run it in a new tab. "Explain with AI", "Fix with AI" (on errors) and "Ask AI to optimize" (on plans) send your editor context along.
- **Insights**: a background scan (every 30 minutes by default, plus an "Analyze now" button) finds schema and performance problems. The AI explains each one and proposes fix SQL.

## Quick start

```bash
cd pgadmin+
cp .env.example .env        # then put your OPENAI_API_KEY in .env
docker compose up -d --build
```

Open http://localhost:8080, click **+** next to *Connections*, and add your database.

| Where is your database? | Host to use |
|---|---|
| On this machine (outside Docker) | `host.docker.internal`, not `localhost` |
| Another container | Its service or container name (it must share a Docker network) |
| Cloud (RDS, Cloud SQL, Azure, Supabase, Neon, …) | The provider's hostname, usually with SSL mode `require` |

You can also paste a connection string such as `postgresql://user:pass@host:5432/db?sslmode=require` into the dialog.

### Try it with a sample database

`scripts/seed_sample.sql` builds a small shop database with deliberate problems for Insights to find: foreign keys without indexes, a table without a primary key, and a duplicate index.

```bash
docker run -d --name pgplus-sample -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
docker exec -i pgplus-sample psql -U postgres < scripts/seed_sample.sql
```

Then connect with host `host.docker.internal`, port `5433`, database `shop`, and user and password `postgres`.

## How the AI is kept safe

- The chat agent can only call read-only tools: list and describe tables, table stats, sample rows, `run_readonly_query`, and `EXPLAIN`.
- Before a query runs, it is classified, and anything that isn't a read is rejected.
- Queries then execute inside a `READ ONLY` transaction with a 10-second timeout. Even a function with side effects, such as `nextval()`, fails.
- The AI **never** runs writes. It gives you the SQL, and you review and run it from the editor.
- In the editor, statements that destroy data ask for confirmation before running: `DROP`, `TRUNCATE`, `DELETE` or `UPDATE` without `WHERE`, and `ALTER … DROP`.
- `EXPLAIN ANALYZE` always runs inside a transaction that is rolled back, so analyzing an `UPDATE` doesn't change data.
- The AI sees your schema and any query results its tools return. Those are sent to OpenAI (or to `OPENAI_BASE_URL` if you set one).

## Insights checks

| Check | Notes |
|---|---|
| Foreign key without a supporting index | Fix: `CREATE INDEX CONCURRENTLY …` |
| Duplicate indexes / redundant prefix indexes | |
| Unused indexes | The table is used but the index has zero scans. Only shown after the condition has lasted 24 hours, so an index you just created isn't flagged. |
| Invalid indexes | Usually left behind by a failed `CREATE INDEX CONCURRENTLY` |
| Tables without a primary key | |
| Dead-tuple bloat, never-analyzed tables | |
| Large tables read mostly by sequential scans | |
| Slow queries | Read from `pg_stat_statements` when installed; otherwise you get a tip on how to enable it |
| Low buffer cache hit ratio | |

New findings go to the LLM in a single batched call, which writes the explanation, the impact and the fix SQL. Each re-scan updates existing findings: findings that went away move to **Resolved**, and **Dismissed** ones stay dismissed.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `OPENAI_API_KEY` | (empty) | Required for chat and AI explanations. Without it, the editor and the rule-based insights still work. |
| `OPENAI_MODEL` | `gpt-4.1` | Any chat-completions model that supports tool calling |
| `OPENAI_BASE_URL` | (empty) | Optional OpenAI-compatible endpoint |
| `APP_SECRET_KEY` | (empty) | Encrypts saved passwords. If empty, a key is generated and stored in the meta DB. |
| `INSIGHTS_INTERVAL_MINUTES` | `30` | `0` disables the background scan |
| `QUERY_ROW_LIMIT` | `1000` | Default max rows per statement (also selectable in the UI) |
| `QUERY_TIMEOUT_SECONDS` | `120` | `statement_timeout` for editor queries |
| `APP_PORT` | `8080` | Host port for the UI |
| `META_DB_PORT` | `5434` | Host port (bound to 127.0.0.1) for the app's own metadata Postgres |

## Architecture

```
browser ── nginx (frontend: React + Vite + Monaco, serves the SPA and proxies /api)
              │
              └── backend (FastAPI, asyncpg, OpenAI SDK, APScheduler)
                     ├── meta-db (Postgres: saved connections, chat history, insights, query history)
                     └── your databases (one asyncpg pool per saved connection)
```

- `backend/app/pg/`: connection pools, script execution (statement splitting, row limits, cancel), introspection, and the SQL safety classifier
- `backend/app/ai/`: the streaming chat agent (OpenAI function calling, served to the browser over SSE) and its read-only tools
- `backend/app/insights/`: rule checks, the AI enrichment step, and the scheduler
- `frontend/src/components/`: the editor, results, schema tree, chat and insights panels

### Inspecting the app database

The metadata Postgres (`meta-db`) is published on `127.0.0.1:5434`. Connect with host `localhost`, port `5434`, database `pgplus`, user `pgplus`, password `pgplus`. Saved connection passwords in the `connections` table are encrypted.

### Local development

```bash
# backend (needs a Postgres for metadata)
cd backend && pip install -r requirements.txt pytest
META_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/pgplus uvicorn app.main:app --reload
pytest                                  # statement splitter / safety classifier tests

# frontend (proxies /api to API_URL, default http://localhost:8000)
cd frontend && npm install && npm run dev
```

## Limitations (POC)

- **There is no login.** It is a single-user tool, so don't expose it to the internet as-is.
- Each run uses a pooled connection. A transaction left open at the end of a script is rolled back. Session state such as `SET` or temp tables does not carry over between runs.
