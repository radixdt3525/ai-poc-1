import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef, useState } from 'react'
import type { StatementResult } from '../../api/types'
import { cellText } from '../common/format'

const ROW_H = 26
const NUM_W = 52

function columnWidths(res: StatementResult): number[] {
  return res.columns.map((c, i) => {
    let longest = Math.max(c.name.length, c.type.length + 2)
    for (let r = 0; r < Math.min(res.rows.length, 50); r++) longest = Math.max(longest, cellText(res.rows[r][i]).length)
    return Math.min(Math.max(longest * 7.4 + 24, 80), 420)
  })
}

export function DataGrid({ result }: { result: StatementResult }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const widths = useMemo(() => columnWidths(result), [result])
  const total = widths.reduce((a, b) => a + b, NUM_W)
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null)
  const virtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  })
  const template = `${NUM_W}px ${widths.map((w) => `${w}px`).join(' ')}`

  return (
    <div ref={parentRef} className="h-full overflow-auto font-mono text-[12px]">
      <div style={{ width: total, minWidth: '100%' }}>
        <div className="sticky top-0 z-10 grid border-b border-zinc-700 bg-zinc-900" style={{ gridTemplateColumns: template }}>
          <div className="border-r border-zinc-800" />
          {result.columns.map((c, i) => (
            <div key={i} className="truncate border-r border-zinc-800 px-2 py-1" title={`${c.name} (${c.type})`}>
              <div className="truncate font-sans text-xs font-semibold text-zinc-100">{c.name}</div>
              <div className="truncate font-sans text-[10px] text-zinc-500">{c.type}</div>
            </div>
          ))}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = result.rows[v.index]
            return (
              <div
                key={v.key}
                className={`absolute left-0 grid w-full border-b border-zinc-900 ${v.index % 2 ? 'bg-zinc-900/30' : ''} hover:bg-zinc-800/50`}
                style={{ top: v.start, height: ROW_H, gridTemplateColumns: template }}
              >
                <div className="border-r border-zinc-800 px-2 text-right leading-[26px] text-zinc-600">{v.index + 1}</div>
                {row.map((cell, ci) => {
                  const isSel = selected?.r === v.index && selected.c === ci
                  const text = cellText(cell)
                  return (
                    <div
                      key={ci}
                      className={`truncate border-r border-zinc-900 px-2 leading-[26px] ${
                        cell === null ? 'italic text-zinc-600' : typeof cell === 'number' ? 'text-right text-violet-200' : 'text-zinc-200'
                      } ${isSel ? 'outline outline-1 -outline-offset-1 outline-sky-500 bg-sky-500/10' : ''}`}
                      title={text.length > 40 ? text.slice(0, 2000) : undefined}
                      onClick={() => setSelected({ r: v.index, c: ci })}
                      onDoubleClick={() => navigator.clipboard.writeText(cell === null ? '' : text)}
                    >
                      {text}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
