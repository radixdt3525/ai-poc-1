import type {
  AppConfig,
  ChatEvent,
  ChatMessage,
  ChatSession,
  CompletionRelation,
  Connection,
  ConnectionInput,
  DestructiveStatement,
  ExecResult,
  ExplainResult,
  HistoryEntry,
  InsightList,
  RelationDetails,
  SchemaInfo,
  SchemaObjects,
  TestResult,
} from './types'

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message)
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const detail = data?.detail
    const msg = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : res.statusText
    throw new ApiError(msg, res.status, data)
  }
  return data as T
}

const enc = encodeURIComponent

export type RunResponse =
  | { kind: 'result'; data: ExecResult }
  | { kind: 'confirm'; statements: DestructiveStatement[] }

export const api = {
  config: () => req<AppConfig>('GET', '/config'),

  connections: () => req<Connection[]>('GET', '/connections'),
  createConnection: (body: ConnectionInput) => req<Connection>('POST', '/connections', body),
  updateConnection: (id: string, body: ConnectionInput) => req<Connection>('PUT', `/connections/${id}`, body),
  deleteConnection: (id: string) => req('DELETE', `/connections/${id}`),
  testConnection: (body: ConnectionInput & { id?: string }) => req<TestResult>('POST', '/connections/test', body),

  schemas: (c: string) => req<SchemaInfo[]>('GET', `/connections/${c}/schemas`),
  objects: (c: string, schema: string) => req<SchemaObjects>('GET', `/connections/${c}/schemas/${enc(schema)}/objects`),
  relation: (c: string, schema: string, name: string) =>
    req<RelationDetails>('GET', `/connections/${c}/relations/${enc(schema)}/${enc(name)}`),
  completion: (c: string) => req<CompletionRelation[]>('GET', `/connections/${c}/completion`),
  refreshSchema: (c: string) => req('POST', `/connections/${c}/refresh`),

  async runQuery(
    c: string,
    body: { sql: string; run_id: string; row_limit: number; confirm_destructive?: boolean },
  ): Promise<RunResponse> {
    try {
      return { kind: 'result', data: await req<ExecResult>('POST', `/connections/${c}/query`, body) }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        return { kind: 'confirm', statements: (e.body as { statements: DestructiveStatement[] }).statements }
      }
      throw e
    }
  },
  cancelQuery: (c: string, run_id: string) => req<{ cancelled: boolean }>('POST', `/connections/${c}/query/cancel`, { run_id }),
  explain: (c: string, sql: string, analyze: boolean) =>
    req<ExplainResult>('POST', `/connections/${c}/explain`, { sql, analyze }),
  history: (c: string) => req<HistoryEntry[]>('GET', `/connections/${c}/history`),

  chatSessions: (c: string) => req<ChatSession[]>('GET', `/connections/${c}/chat/sessions`),
  createChatSession: (c: string) => req<ChatSession>('POST', `/connections/${c}/chat/sessions`, {}),
  deleteChatSession: (id: string) => req('DELETE', `/chat/sessions/${id}`),
  chatMessages: (id: string) => req<ChatMessage[]>('GET', `/chat/sessions/${id}/messages`),

  insights: (c: string, status: string) => req<InsightList>('GET', `/connections/${c}/insights?status=${status}`),
  analyze: (c: string) =>
    req<{ findings: number; new: number; resolved: number; error: string | null }>(
      'POST',
      `/connections/${c}/insights/analyze`,
    ),
  markInsightsRead: (c: string) => req('POST', `/connections/${c}/insights/mark-read`),
  setInsightStatus: (id: string, action: 'dismiss' | 'reopen') => req('POST', `/insights/${id}/${action}`),
}

export async function streamChat(
  sessionId: string,
  body: { message: string; editor_sql?: string | null; editor_error?: string | null },
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new ApiError(`Chat failed: ${res.statusText}`, res.status, null)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)))
      }
    }
  }
}
