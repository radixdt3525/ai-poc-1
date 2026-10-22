import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2, RefreshCw, RotateCcw, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { Insight } from '../../api/types'
import { useStore } from '../../store'
import { SqlBlock } from '../common/SqlBlock'
import { timeAgo } from '../common/format'

const SEVERITY: Record<Insight['severity'], string> = {
  high: 'bg-red-500/15 text-red-300 border-red-500/30',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  low: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  info: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
}

function InsightCard({ insight, connId }: { insight: Insight; connId: string }) {
  const qc = useQueryClient()
  const askAI = useStore((s) => s.askAI)
  const [showDetails, setShowDetails] = useState(false)
  const statusMut = useMutation({
    mutationFn: (action: 'dismiss' | 'reopen') => api.setInsightStatus(insight.id, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insights', connId] }),
  })
  return (
    <div className={`rounded-lg border bg-zinc-900/40 p-3 ${insight.is_read ? 'border-zinc-800' : 'border-amber-500/40'}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 rounded border px-1.5 text-[10px] font-semibold uppercase ${SEVERITY[insight.severity]}`}>
          {insight.severity}
        </span>
        <div className="min-w-0 flex-1 text-[13px] font-medium text-zinc-100">{insight.title}</div>
        {insight.status === 'open' ? (
          <button className="icon-btn" title="Dismiss" onClick={() => statusMut.mutate('dismiss')}>
            <X size={13} />
          </button>
        ) : (
          insight.status === 'dismissed' && (
            <button className="icon-btn" title="Reopen" onClick={() => statusMut.mutate('reopen')}>
              <RotateCcw size={12} />
            </button>
          )
        )}
      </div>
      {insight.explanation && <p className="mt-2 text-xs leading-relaxed text-zinc-300">{insight.explanation}</p>}
      {insight.impact && (
        <p className="mt-1 text-xs leading-relaxed text-emerald-300/90">
          <span className="font-medium">Impact:</span> {insight.impact}
        </p>
      )}
      {insight.fix_sql && <SqlBlock sql={insight.fix_sql} title={`Fix: ${insight.check}`} />}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
        <button className="flex items-center gap-0.5 hover:text-zinc-300" onClick={() => setShowDetails(!showDetails)}>
          <ChevronRight size={11} className={showDetails ? 'rotate-90' : ''} /> details
        </button>
        {insight.ai_generated && (
          <span className="flex items-center gap-1 text-violet-400">
            <Sparkles size={10} /> AI explained
          </span>
        )}
        <span className="ml-auto">first seen {timeAgo(insight.first_seen)}</span>
        <button
          className="flex items-center gap-1 text-violet-300 hover:text-violet-200"
          onClick={() =>
            askAI(
              `Help me with this database insight. Verify it against the live database and tell me exactly what to do.\n\nInsight: ${insight.title}\nCheck: ${insight.check}\nDetails: ${JSON.stringify(insight.details)}\nSuggested fix:\n${insight.fix_sql ?? '(none)'}`,
            )
          }
        >
          <Sparkles size={10} /> Ask AI
        </button>
      </div>
      {showDetails && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-400">
          {JSON.stringify(insight.details, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function InsightsPanel() {
  const connId = useStore((s) => s.activeConnectionId)
  const visible = useStore((s) => s.rightPanel === 'insights')
  const qc = useQueryClient()
  const [status, setStatus] = useState<'open' | 'dismissed' | 'resolved'>('open')
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.config })
  const { data, isLoading, error } = useQuery({
    queryKey: ['insights', connId, status],
    queryFn: () => api.insights(connId!, status),
    enabled: !!connId,
    refetchInterval: 60_000,
  })
  const analyze = useMutation({
    mutationFn: () => api.analyze(connId!),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['insights', connId] })
      qc.invalidateQueries({ queryKey: ['connections'] })
    },
  })

  // Viewing the panel marks findings as read (after a moment, so new ones stay highlighted).
  const unread = data?.unread ?? 0
  useEffect(() => {
    if (!connId || !unread || !visible) return
    const t = setTimeout(async () => {
      await api.markInsightsRead(connId)
      qc.invalidateQueries({ queryKey: ['insights', connId] })
    }, 4000)
    return () => clearTimeout(t)
  }, [connId, unread, visible, qc])

  if (!connId) return <div className="p-4 text-xs text-zinc-500">Select a connection to see optimization insights.</div>

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 border-b border-zinc-800 p-2">
        <div className="flex items-center gap-2">
          <button className="btn-primary" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
            {analyze.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {analyze.isPending ? 'Analyzing…' : 'Analyze now'}
          </button>
          <span className="text-[11px] text-zinc-500">
            Last scan {timeAgo(data?.last_analyzed_at)}
            {config && config.insights_interval_minutes > 0 && ` · auto every ${config.insights_interval_minutes} min`}
          </span>
        </div>
        <div className="flex gap-1">
          {(['open', 'dismissed', 'resolved'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] capitalize ${status === s ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800'}`}
            >
              {s}
            </button>
          ))}
        </div>
        {analyze.data && (
          <div className="text-[11px] text-zinc-400">
            Scan complete: {analyze.data.findings} finding(s), {analyze.data.new} new, {analyze.data.resolved} resolved.
          </div>
        )}
        {(analyze.error || data?.last_analysis_error) && (
          <div className="rounded border border-red-500/30 bg-red-500/10 p-1.5 text-[11px] text-red-300">
            {analyze.error ? (analyze.error as Error).message : data?.last_analysis_error}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {isLoading && <Loader2 size={14} className="m-3 animate-spin text-zinc-500" />}
        {error && <div className="p-2 text-xs text-red-300">{(error as Error).message}</div>}
        {data && data.items.length === 0 && (
          <div className="mt-8 text-center text-xs text-zinc-500">
            <ShieldCheck size={24} className="mx-auto mb-2 text-emerald-500/70" />
            {status === 'open'
              ? data.last_analyzed_at
                ? 'No open issues found. Nice!'
                : 'Not analyzed yet. Click “Analyze now”.'
              : `No ${status} insights.`}
          </div>
        )}
        {data?.items.map((i) => <InsightCard key={i.id} insight={i} connId={connId} />)}
      </div>
    </div>
  )
}
