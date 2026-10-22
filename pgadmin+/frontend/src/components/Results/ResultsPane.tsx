import { useQuery } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Clock, Copy, Download, Sparkles } from 'lucide-react'
import { api } from '../../api/client'
import type { ExecResult } from '../../api/types'
import { useActiveTab, useStore, type ResultView, type Tab } from '../../store'
import { timeAgo, toCsv } from '../common/format'
import { DataGrid } from './DataGrid'
import { PlanView } from './PlanView'

function DataView({ tab }: { tab: Tab }) {
  const updateTab = useStore((s) => s.updateTab)
  const result = tab.result
  const withRows = result?.results.map((r, i) => ({ r, i })).filter(({ r }) => r.columns.length > 0) ?? []
  if (!result || !withRows.length) {
    return <Empty>{tab.running ? 'Running…' : 'Run a query to see its output here.'}</Empty>
  }
  const current = result.results[tab.resultIndex]?.columns.length ? result.results[tab.resultIndex] : withRows[withRows.length - 1].r
  const csv = () => toCsv(current.columns.map((c) => c.name), current.rows)
  const download = () => {
    const url = URL.createObjectURL(new Blob([csv()], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${tab.title.replace(/\W+/g, '_')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-zinc-800 px-3 text-xs text-zinc-400">
        {withRows.length > 1 && (
          <select className="input !w-auto !py-0 text-xs" value={tab.resultIndex} onChange={(e) => updateTab(tab.id, { resultIndex: Number(e.target.value) })}>
            {withRows.map(({ i }, n) => (
              <option key={i} value={i}>
                Result {n + 1}
              </option>
            ))}
          </select>
        )}
        <span>
          <span className="text-zinc-200">{current.row_count?.toLocaleString()}</span> rows
        </span>
        <span className="flex items-center gap-1">
          <Clock size={11} /> {current.duration_ms} ms
        </span>
        {current.truncated && (
          <span className="rounded bg-amber-500/15 px-1.5 text-amber-300">
            truncated at {tab.rowLimit.toLocaleString()} rows: raise the row limit or add LIMIT/OFFSET
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(csv())}>
            <Copy size={12} /> Copy CSV
          </button>
          <button className="btn-ghost" onClick={download}>
            <Download size={12} /> CSV
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DataGrid key={`${tab.id}-${tab.resultIndex}-${result.duration_ms}`} result={current} />
      </div>
    </div>
  )
}

function MessagesView({ tab }: { tab: Tab }) {
  const askAI = useStore((s) => s.askAI)
  const result: ExecResult | undefined = tab.result
  if (tab.requestError) {
    return (
      <div className="p-3">
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-red-200">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap break-all">{tab.requestError}</span>
        </div>
      </div>
    )
  }
  if (!result) return <Empty>No messages yet.</Empty>
  return (
    <div className="h-full space-y-2 overflow-auto p-3 font-mono text-[12px]">
      {result.results.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-zinc-300">
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
          <div className="min-w-0">
            <div>
              <span className="text-emerald-300">{r.status}</span>
              <span className="text-zinc-500"> · {r.duration_ms} ms</span>
            </div>
            <div className="truncate text-zinc-500">{r.sql.split('\n')[0]}</div>
          </div>
        </div>
      ))}
      {result.notices.map((n, i) => (
        <div key={`n${i}`} className="text-sky-300">
          {n}
        </div>
      ))}
      {result.error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-red-200">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="font-semibold">
                ERROR{result.error.sqlstate ? ` [${result.error.sqlstate}]` : ''}: {result.error.message}
              </div>
              {result.error.detail && <div>DETAIL: {result.error.detail}</div>}
              {result.error.hint && <div>HINT: {result.error.hint}</div>}
              <pre className="whitespace-pre-wrap text-red-300/70">{result.error.sql}</pre>
            </div>
          </div>
          <button
            className="btn-outline mt-2 border-amber-500/40 font-sans text-amber-200"
            onClick={() => askAI('Fix the error in my query.', { includeEditor: true, error: `${result.error!.message}${result.error!.hint ? `\nHINT: ${result.error!.hint}` : ''}` })}
          >
            <Sparkles size={12} /> Fix with AI
          </button>
        </div>
      )}
      <div className="pt-1 text-zinc-500">
        {result.statement_count} statement(s) · total {result.duration_ms} ms
      </div>
    </div>
  )
}

function HistoryView({ tab }: { tab: Tab }) {
  const addTab = useStore((s) => s.addTab)
  const { data, isLoading } = useQuery({
    queryKey: ['history', tab.connectionId, tab.result?.duration_ms],
    queryFn: () => api.history(tab.connectionId!),
    enabled: !!tab.connectionId,
  })
  if (!tab.connectionId) return <Empty>Select a connection.</Empty>
  if (isLoading) return <Empty>Loading…</Empty>
  if (!data?.length) return <Empty>No queries run on this connection yet.</Empty>
  return (
    <div className="h-full overflow-auto">
      {data.map((h) => (
        <div
          key={h.id}
          className="flex cursor-pointer items-start gap-3 border-b border-zinc-900 px-3 py-1.5 hover:bg-zinc-900"
          onClick={() => addTab({ sql: h.sql, title: `History #${h.id}`, connectionId: tab.connectionId })}
          title="Open in a new tab"
        >
          {h.status === 'ok' ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" /> : <AlertCircle size={13} className="mt-0.5 shrink-0 text-red-400" />}
          <pre className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-300">{h.sql.replace(/\s+/g, ' ')}</pre>
          <span className="shrink-0 text-[11px] text-zinc-500">
            {Math.round(h.duration_ms)} ms · {timeAgo(h.created_at)}
          </span>
        </div>
      ))}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-xs text-zinc-500">{children}</div>
}

export function ResultsPane() {
  const tab = useActiveTab()
  const updateTab = useStore((s) => s.updateTab)
  const views: { key: ResultView; label: string; badge?: boolean }[] = [
    { key: 'data', label: 'Data output' },
    { key: 'messages', label: 'Messages', badge: !!(tab.result?.error || tab.requestError) },
    { key: 'plan', label: 'Explain' },
    { key: 'history', label: 'History' },
  ]
  return (
    <div className="flex h-full flex-col border-t border-zinc-800 bg-zinc-950">
      <div className="flex h-8 shrink-0 items-stretch border-b border-zinc-800 px-1">
        {views.map((v) => (
          <button
            key={v.key}
            onClick={() => updateTab(tab.id, { view: v.key })}
            className={`flex items-center gap-1.5 border-b-2 px-3 text-xs ${
              tab.view === v.key ? 'border-sky-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {v.label}
            {v.badge && <span className="h-1.5 w-1.5 rounded-full bg-red-500" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab.view === 'data' && <DataView tab={tab} />}
        {tab.view === 'messages' && <MessagesView tab={tab} />}
        {tab.view === 'plan' && (tab.explain ? <PlanView explain={tab.explain} /> : <Empty>Use Explain / Analyze to see the query plan.</Empty>)}
        {tab.view === 'history' && <HistoryView tab={tab} />}
      </div>
    </div>
  )
}
