import { AlertTriangle } from 'lucide-react'
import { useStore } from '../../store'
import { Modal } from './Modal'

export function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm)
  const resolve = useStore((s) => s.resolveConfirm)
  if (!confirm) return null
  return (
    <Modal
      title={
        <span className="flex items-center gap-2 text-red-300">
          <AlertTriangle size={16} /> Destructive statement
        </span>
      }
      onClose={() => resolve(false)}
      footer={
        <>
          <button className="btn-outline" onClick={() => resolve(false)} autoFocus>
            Cancel
          </button>
          <button className="btn-danger" onClick={() => resolve(true)}>
            Run anyway
          </button>
        </>
      }
    >
      <p className="mb-3 text-zinc-300">This script contains statements that can permanently remove data:</p>
      <ul className="space-y-2">
        {confirm.statements.map((s, i) => (
          <li key={i} className="rounded-md border border-red-500/30 bg-red-500/5 p-2">
            <div className="mb-1 text-xs font-medium text-red-300">{s.reason}</div>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs text-zinc-300">{s.sql}</pre>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
