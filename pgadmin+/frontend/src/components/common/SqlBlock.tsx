import { Check, Copy, CornerDownLeft, Play } from 'lucide-react'
import { useState } from 'react'
import { insertIntoEditor } from '../Editor/editorBridge'
import { useStore } from '../../store'

/** A SQL snippet with "Insert into editor", "Run in new tab" and "Copy" actions. */
export function SqlBlock({ sql, title }: { sql: string; title?: string }) {
  const [copied, setCopied] = useState(false)
  const addTab = useStore((s) => s.addTab)
  const runTab = useStore((s) => s.runTab)

  const run = () => {
    const id = addTab({ sql, title: title ?? 'AI query' })
    void runTab(id)
  }
  const copy = async () => {
    await navigator.clipboard.writeText(sql)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">sql</span>
        <div className="ml-auto flex gap-1">
          <button className="btn-ghost !px-1.5 !py-0.5" onClick={() => insertIntoEditor(sql)} title="Insert at cursor in the editor">
            <CornerDownLeft size={12} /> Insert
          </button>
          <button className="btn-ghost !px-1.5 !py-0.5" onClick={run} title="Open in a new tab and run">
            <Play size={12} /> Run
          </button>
          <button className="btn-ghost !px-1.5 !py-0.5" onClick={copy} title="Copy">
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
      <pre className="whitespace-pre-wrap break-words p-2.5 font-mono text-[12px] leading-5 text-sky-100">{sql}</pre>
    </div>
  )
}
