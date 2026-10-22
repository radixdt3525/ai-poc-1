import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { Connection } from '../../api/types'
import { useStore } from '../../store'
import { ConnectionDialog } from './ConnectionDialog'

export function ConnectionList() {
  const qc = useQueryClient()
  const { data: connections = [], isSuccess } = useQuery({ queryKey: ['connections'], queryFn: api.connections })
  const activeId = useStore((s) => s.activeConnectionId)
  const setActive = useStore((s) => s.setActiveConnection)
  const [dialog, setDialog] = useState<{ existing?: Connection } | null>(null)

  // Drop a remembered connection that no longer exists; pick the first one by default.
  useEffect(() => {
    if (!isSuccess) return
    if (activeId && !connections.some((c) => c.id === activeId)) setActive(connections[0]?.id ?? null)
    else if (!activeId && connections.length) setActive(connections[0].id)
  }, [isSuccess, connections, activeId, setActive])

  const del = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  })

  return (
    <div className="shrink-0 border-b border-zinc-800">
      <div className="panel-header">
        Connections
        <button className="icon-btn ml-auto" title="New connection" onClick={() => setDialog({})}>
          <Plus size={14} />
        </button>
      </div>
      <ul className="max-h-48 overflow-auto py-1">
        {connections.length === 0 && (
          <li className="px-3 py-2 text-xs text-zinc-500">
            No connections yet.{' '}
            <button className="text-sky-400 hover:underline" onClick={() => setDialog({})}>
              Add one
            </button>
          </li>
        )}
        {connections.map((c) => (
          <li
            key={c.id}
            className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
              c.id === activeId ? 'bg-sky-500/10 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'
            }`}
            onClick={() => setActive(c.id)}
          >
            <Database size={13} className={c.id === activeId ? 'text-sky-400' : 'text-zinc-500'} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{c.name}</div>
              <div className="truncate font-mono text-[10px] text-zinc-500">
                {c.host}/{c.database}
              </div>
            </div>
            <button
              className="icon-btn hidden group-hover:inline-flex"
              title="Edit"
              onClick={(e) => {
                e.stopPropagation()
                setDialog({ existing: c })
              }}
            >
              <Pencil size={12} />
            </button>
            <button
              className="icon-btn hidden hover:!text-red-400 group-hover:inline-flex"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(`Delete connection "${c.name}"? Chat history and insights for it are removed too.`)) del.mutate(c.id)
              }}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
      {dialog && (
        <ConnectionDialog
          existing={dialog.existing}
          onClose={() => setDialog(null)}
          onSaved={(c) => {
            setDialog(null)
            setActive(c.id)
          }}
        />
      )}
    </div>
  )
}
