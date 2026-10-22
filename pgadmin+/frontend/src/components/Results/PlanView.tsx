import { ChevronRight, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { ExplainResult } from '../../api/types'
import { useStore } from '../../store'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlanNode = Record<string, any> & { Plans?: PlanNode[] }

function nodeLabel(n: PlanNode): string {
  const parts = [n['Node Type']]
  if (n['Join Type'] && !String(n['Node Type']).includes(n['Join Type'])) parts.unshift(n['Join Type'])
  if (n['Relation Name']) parts.push(`on ${n['Schema'] ? `${n['Schema']}.` : ''}${n['Relation Name']}${n['Alias'] && n['Alias'] !== n['Relation Name'] ? ` ${n['Alias']}` : ''}`)
  if (n['Index Name']) parts.push(`using ${n['Index Name']}`)
  return parts.join(' ')
}

const DETAIL_KEYS = ['Filter', 'Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Recheck Cond', 'Sort Key', 'Group Key', 'Rows Removed by Filter']

function Node({ node, depth, maxTime }: { node: PlanNode; depth: number; maxTime: number }) {
  const [open, setOpen] = useState(true)
  const children = node.Plans ?? []
  const actual = node['Actual Total Time'] as number | undefined
  const loops = (node['Actual Loops'] as number | undefined) ?? 1
  const timeShare = actual != null && maxTime > 0 ? (actual * loops) / maxTime : 0
  const isSeq = String(node['Node Type']).includes('Seq Scan')
  const misestimate =
    node['Actual Rows'] != null && node['Plan Rows'] > 0
      ? Math.max(node['Actual Rows'] / node['Plan Rows'], node['Plan Rows'] / Math.max(node['Actual Rows'], 1))
      : 1
  return (
    <div>
      <div className="flex items-start gap-1.5 py-1 hover:bg-zinc-900" style={{ paddingLeft: depth * 18 + 8 }}>
        <button className={`mt-0.5 text-zinc-500 ${children.length ? '' : 'invisible'}`} onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={open ? 'rotate-90' : ''} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`font-medium ${isSeq ? 'text-amber-300' : 'text-sky-200'}`}>{nodeLabel(node)}</span>
            <span className="text-[11px] text-zinc-500">
              cost {node['Startup Cost']}..{node['Total Cost']} · est. {node['Plan Rows']} rows
            </span>
            {actual != null && (
              <span className="text-[11px] text-zinc-400">
                actual {actual} ms × {loops} · {node['Actual Rows']} rows
              </span>
            )}
            {misestimate > 10 && (
              <span className="rounded bg-red-500/15 px-1.5 text-[10px] text-red-300">row estimate off ×{Math.round(misestimate)}</span>
            )}
          </div>
          {DETAIL_KEYS.filter((k) => node[k] != null).map((k) => (
            <div key={k} className="truncate font-mono text-[11px] text-zinc-500">
              {k}: {Array.isArray(node[k]) ? node[k].join(', ') : String(node[k])}
            </div>
          ))}
          {timeShare > 0 && (
            <div className="mt-1 h-1 w-48 rounded bg-zinc-800">
              <div className="h-1 rounded bg-sky-500" style={{ width: `${Math.min(timeShare * 100, 100)}%` }} />
            </div>
          )}
        </div>
      </div>
      {open && children.map((c, i) => <Node key={i} node={c} depth={depth + 1} maxTime={maxTime} />)}
    </div>
  )
}

export function PlanView({ explain }: { explain: ExplainResult }) {
  const askAI = useStore((s) => s.askAI)
  const root = explain.plan?.[0] ?? {}
  const plan: PlanNode = root.Plan ?? {}
  const maxTime = (root['Execution Time'] as number | undefined) ?? (plan['Actual Total Time'] as number | undefined) ?? 0
  const ask = () => {
    const json = JSON.stringify(explain.plan).slice(0, 12000)
    askAI(
      `Here is the ${explain.analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN'} plan (JSON) for the query in my editor. Explain the bottlenecks and how to make it faster (indexes, rewrites, stats).\n\n\`\`\`json\n${json}\n\`\`\``,
      { includeEditor: true },
    )
  }
  return (
    <div className="h-full overflow-auto text-[12px]">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-400">
        <span className="font-semibold text-zinc-200">{explain.analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN'}</span>
        {root['Planning Time'] != null && <span>planning {root['Planning Time']} ms</span>}
        {root['Execution Time'] != null && <span>execution {root['Execution Time']} ms</span>}
        {explain.analyze && <span className="text-zinc-500">(ran inside a transaction that was rolled back)</span>}
        <button className="btn-ghost ml-auto text-violet-300" onClick={ask}>
          <Sparkles size={12} /> Ask AI to optimize
        </button>
      </div>
      <div className="py-1">
        <Node node={plan} depth={0} maxTime={maxTime} />
      </div>
    </div>
  )
}
