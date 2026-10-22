export interface AppConfig {
  ai_enabled: boolean
  model: string
  insights_interval_minutes: number
  row_limit: number
}

export interface Connection {
  id: string
  name: string
  host: string
  port: number
  database: string
  username: string
  sslmode: string
  has_password: boolean
  last_analyzed_at: string | null
  last_analysis_error: string | null
}

export interface ConnectionInput {
  name: string
  host: string
  port: number
  database: string
  username: string
  password: string | null
  sslmode: string
}

export interface TestResult {
  ok: boolean
  error?: string
  version?: string
  database?: string
  user?: string
}

export interface SchemaInfo {
  name: string
  tables: number
  views: number
}

export interface RelationSummary {
  name: string
  kind: string
  row_estimate: number
  total_bytes: number
  comment: string | null
}

export interface FunctionSummary {
  name: string
  args: string
  result: string
  kind: string
}

export interface SchemaObjects {
  tables: RelationSummary[]
  views: RelationSummary[]
  materialized_views: RelationSummary[]
  sequences: RelationSummary[]
  foreign_tables: RelationSummary[]
  functions: FunctionSummary[]
}

export interface RelationDetails {
  schema: string
  name: string
  kind: string
  columns: { name: string; type: string; not_null: boolean; default: string | null; comment: string | null }[]
  constraints: { name: string; type: string; definition: string }[]
  indexes: {
    name: string
    definition: string
    is_unique: boolean
    is_primary: boolean
    is_valid: boolean
    bytes: number
    scans: number | null
  }[]
  stats: Record<string, unknown>
  view_definition: string | null
  ddl: string
}

export interface CompletionRelation {
  schema: string
  name: string
  kind: string
  columns: string[]
}

export interface StatementResult {
  sql: string
  columns: { name: string; type: string }[]
  rows: unknown[][]
  row_count: number | null
  truncated: boolean
  status: string
  duration_ms: number
}

export interface QueryError {
  message: string
  sqlstate: string | null
  detail: string | null
  hint: string | null
  position: number | null
  sql: string
}

export interface ExecResult {
  results: StatementResult[]
  error: QueryError | null
  notices: string[]
  statement_count: number
  duration_ms: number
  schema_changed?: boolean
}

export interface DestructiveStatement {
  sql: string
  reason: string
}

export interface ExplainResult {
  sql: string
  analyze: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plan: any
}

export interface HistoryEntry {
  id: number
  sql: string
  status: string
  duration_ms: number
  row_count: number | null
  error: string | null
  created_at: string
}

export interface ChatSession {
  id: string
  connection_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface ChatStep {
  name: string
  args: Record<string, unknown>
  preview: string
  ok: boolean
}

export interface ChatMessage {
  id: number | string
  role: 'user' | 'assistant'
  content: string
  steps?: ChatStep[] | null
  pending?: boolean
}

export type ChatEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; preview: string; ok: boolean }
  | { type: 'done'; content: string; steps: ChatStep[] }
  | { type: 'error'; message: string }

export interface Insight {
  id: string
  check: string
  severity: 'high' | 'medium' | 'low' | 'info'
  title: string
  object_name: string | null
  details: Record<string, unknown> | null
  explanation: string | null
  impact: string | null
  fix_sql: string | null
  ai_generated: boolean
  status: 'open' | 'dismissed' | 'resolved'
  is_read: boolean
  first_seen: string
  last_seen: string
}

export interface InsightList {
  items: Insight[]
  unread: number
  last_analyzed_at: string | null
  last_analysis_error: string | null
}
