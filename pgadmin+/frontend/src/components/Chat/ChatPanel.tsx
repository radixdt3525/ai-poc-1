import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, CheckCircle2, ChevronRight, Loader2, Plus, Send, Square, Trash2, Wrench, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamChat } from '../../api/client'
import type { ChatEvent, ChatMessage, ChatStep } from '../../api/types'
import { useStore } from '../../store'
import { Markdown } from './Markdown'

type UiStep = ChatStep & { id?: string; running?: boolean }
type UiMessage = Omit<ChatMessage, 'steps'> & { steps?: UiStep[] | null }

const SUGGESTIONS = [
  'Give me an overview of this database: main entities and how they relate.',
  'Which are the largest tables, and are any of them missing useful indexes?',
  'Write a query that shows the 10 most recent rows from the busiest table.',
  'Are there any slow or risky patterns in this schema I should fix?',
]

function argSummary(args: Record<string, unknown>): string {
  if (typeof args.sql === 'string') return args.sql.replace(/\s+/g, ' ').slice(0, 120)
  return Object.values(args)
    .filter((v) => v !== undefined && v !== '')
    .join('.')
}

function Steps({ steps }: { steps: UiStep[] }) {
  const [open, setOpen] = useState(false)
  const running = steps.some((s) => s.running)
  return (
    <div className="mb-1.5">
      <button className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300" onClick={() => setOpen(!open)}>
        <ChevronRight size={11} className={open ? 'rotate-90' : ''} />
        {running ? <Loader2 size={11} className="animate-spin text-violet-400" /> : <Wrench size={11} />}
        {running ? `Inspecting database (${steps.length})…` : `Inspected database with ${steps.length} tool call${steps.length > 1 ? 's' : ''}`}
      </button>
      {(open || running) && (
        <div className="mt-1 space-y-1 border-l border-zinc-800 pl-3">
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px]">
              {s.running ? (
                <Loader2 size={11} className="mt-0.5 shrink-0 animate-spin text-violet-400" />
              ) : s.ok ? (
                <CheckCircle2 size={11} className="mt-0.5 shrink-0 text-emerald-500" />
              ) : (
                <XCircle size={11} className="mt-0.5 shrink-0 text-red-400" />
              )}
              <div className="min-w-0">
                <span className="font-mono text-violet-300">{s.name}</span>
                <span className="ml-1 break-all font-mono text-zinc-500">{argSummary(s.args)}</span>
                {!s.running && <div className="text-zinc-500">→ {s.preview}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ChatPanel() {
  const connId = useStore((s) => s.activeConnectionId)
  const draft = useStore((s) => s.chatDraft)
  const clearDraft = useStore((s) => s.clearChatDraft)
  const qc = useQueryClient()
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.config })
  const { data: sessions = [] } = useQuery({
    queryKey: ['chatSessions', connId],
    queryFn: () => api.chatSessions(connId!),
    enabled: !!connId,
  })

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [includeEditor, setIncludeEditor] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadedFor = useRef<string | null>(null)

  // Reset the session when switching connections.
  useEffect(() => {
    abortRef.current?.abort()
    setSessionId(null)
    setMessages([])
    loadedFor.current = null
  }, [connId])

  useEffect(() => {
    if (!sessionId || loadedFor.current === sessionId) return
    loadedFor.current = sessionId
    api.chatMessages(sessionId).then((m) => setMessages(m))
  }, [sessionId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const patchLast = (fn: (m: UiMessage) => UiMessage) =>
    setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms))

  const send = useCallback(
    async (text: string, opts: { includeEditor: boolean; error?: string | null }) => {
      if (!connId || !text.trim() || streaming) return
      let sid = sessionId
      if (!sid) {
        const s = await api.createChatSession(connId)
        sid = s.id
        loadedFor.current = sid
        setSessionId(sid)
      }
      const { tabs, activeTabId } = useStore.getState()
      const editorSql = opts.includeEditor ? tabs.find((t) => t.id === activeTabId)?.sql : null
      setMessages((ms) => [
        ...ms,
        { id: `u${Date.now()}`, role: 'user', content: text },
        { id: `a${Date.now()}`, role: 'assistant', content: '', steps: [], pending: true },
      ])
      setInput('')
      setStreaming(true)
      const ctrl = new AbortController()
      abortRef.current = ctrl

      const onEvent = (e: ChatEvent) => {
        if (e.type === 'token') patchLast((m) => ({ ...m, content: m.content + e.content }))
        else if (e.type === 'tool_call')
          patchLast((m) => ({ ...m, steps: [...(m.steps ?? []), { id: e.id, name: e.name, args: e.args, preview: '', ok: true, running: true }] }))
        else if (e.type === 'tool_result')
          patchLast((m) => ({
            ...m,
            steps: (m.steps ?? []).map((s) => (s.id === e.id ? { ...s, preview: e.preview, ok: e.ok, running: false } : s)),
          }))
        else if (e.type === 'done') patchLast((m) => ({ ...m, content: e.content, pending: false }))
        else if (e.type === 'error') patchLast((m) => ({ ...m, content: `${m.content}\n\n**Error:** ${e.message}`, pending: false }))
      }
      try {
        await streamChat(sid, { message: text, editor_sql: editorSql, editor_error: opts.error }, onEvent, ctrl.signal)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') onEvent({ type: 'error', message: (err as Error).message })
      } finally {
        patchLast((m) => ({ ...m, pending: false, steps: m.steps?.map((s) => ({ ...s, running: false })) }))
        setStreaming(false)
        qc.invalidateQueries({ queryKey: ['chatSessions', connId] })
      }
    },
    [connId, sessionId, streaming, qc],
  )

  // Requests coming from elsewhere in the UI ("Fix with AI", "Ask AI about this table", ...)
  useEffect(() => {
    if (!draft || !connId || streaming) return
    clearDraft()
    void send(draft.text, { includeEditor: draft.includeEditor, error: draft.error })
  }, [draft, connId, streaming, send, clearDraft])

  if (!connId) return <div className="p-4 text-xs text-zinc-500">Select a connection to chat about its database.</div>

  const deleteSession = async () => {
    if (!sessionId) return
    await api.deleteChatSession(sessionId)
    setSessionId(null)
    setMessages([])
    qc.invalidateQueries({ queryKey: ['chatSessions', connId] })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-800 px-2">
        <select
          className="input !py-0.5 text-xs"
          value={sessionId ?? ''}
          onChange={(e) => {
            setSessionId(e.target.value || null)
            if (!e.target.value) setMessages([])
          }}
        >
          <option value="">New conversation</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="New conversation" onClick={() => { setSessionId(null); setMessages([]) }}>
          <Plus size={14} />
        </button>
        <button className="icon-btn hover:!text-red-400" title="Delete conversation" disabled={!sessionId} onClick={deleteSession}>
          <Trash2 size={13} />
        </button>
      </div>

      {config && !config.ai_enabled && (
        <div className="m-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
          AI is disabled. Add <code>OPENAI_API_KEY</code> to <code>.env</code> and restart the backend.
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="mt-6 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-violet-500/15">
              <Bot size={20} className="text-violet-300" />
            </div>
            <div className="text-sm font-medium text-zinc-200">Ask anything about your database</div>
            <div className="mt-1 text-xs text-zinc-500">I can inspect schema, stats and data (read-only) and write SQL for you to run.</div>
            <div className="mt-4 space-y-1.5 text-left">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="block w-full rounded-md border border-zinc-800 px-3 py-2 text-left text-xs text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900"
                  onClick={() => send(s, { includeEditor: false })}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-sky-600/20 px-3 py-2 text-[13px] text-zinc-100">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex gap-2">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/15">
                <Bot size={13} className="text-violet-300" />
              </div>
              <div className="min-w-0 flex-1">
                {m.steps && m.steps.length > 0 && <Steps steps={m.steps} />}
                {m.content ? <Markdown text={m.content} /> : m.pending && <Loader2 size={14} className="mt-1 animate-spin text-zinc-500" />}
              </div>
            </div>
          ),
        )}
      </div>

      <div className="shrink-0 border-t border-zinc-800 p-2">
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 focus-within:border-sky-600">
          <textarea
            className="block max-h-40 min-h-[60px] w-full resize-none bg-transparent px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            placeholder="e.g. Show monthly revenue by customer country for 2024"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input, { includeEditor })
              }
            }}
          />
          <div className="flex items-center gap-2 px-2 pb-1.5">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400">
              <input type="checkbox" className="accent-sky-500" checked={includeEditor} onChange={(e) => setIncludeEditor(e.target.checked)} />
              Include editor SQL
            </label>
            {streaming ? (
              <button className="btn-outline ml-auto !py-0.5" onClick={() => abortRef.current?.abort()}>
                <Square size={11} /> Stop
              </button>
            ) : (
              <button className="btn-primary ml-auto !py-0.5" disabled={!input.trim() || !config?.ai_enabled} onClick={() => send(input, { includeEditor })}>
                <Send size={11} /> Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
