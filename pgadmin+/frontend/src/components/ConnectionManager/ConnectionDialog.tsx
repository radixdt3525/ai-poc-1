import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import type { Connection, ConnectionInput, TestResult } from '../../api/types'
import { Modal } from '../common/Modal'

const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

function parseUrl(raw: string): Partial<ConnectionInput> | null {
  try {
    const url = new URL(raw.trim().replace(/^postgres(ql)?:/, 'http:'))
    const sslmode = url.searchParams.get('sslmode')
    return {
      host: decodeURIComponent(url.hostname),
      port: url.port ? Number(url.port) : 5432,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
      username: decodeURIComponent(url.username),
      password: url.password ? decodeURIComponent(url.password) : null,
      ...(sslmode && SSL_MODES.includes(sslmode) ? { sslmode } : {}),
    }
  } catch {
    return null
  }
}

export function ConnectionDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Connection
  onClose: () => void
  onSaved: (c: Connection) => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<ConnectionInput>({
    name: existing?.name ?? '',
    host: existing?.host ?? 'host.docker.internal',
    port: existing?.port ?? 5432,
    database: existing?.database ?? 'postgres',
    username: existing?.username ?? 'postgres',
    password: existing ? null : '',
    sslmode: existing?.sslmode ?? 'prefer',
  })
  const [url, setUrl] = useState('')
  const [test, setTest] = useState<TestResult | null>(null)
  const set = <K extends keyof ConnectionInput>(k: K, v: ConnectionInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setTest(null)
  }

  const testMut = useMutation({
    mutationFn: () => api.testConnection({ ...form, id: existing?.id }),
    onSuccess: setTest,
    onError: (e: Error) => setTest({ ok: false, error: e.message }),
  })
  const saveMut = useMutation({
    mutationFn: () => {
      const body = { ...form, name: form.name || `${form.database}@${form.host}` }
      return existing ? api.updateConnection(existing.id, body) : api.createConnection(body)
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      qc.invalidateQueries({ queryKey: ['schemas', c.id] })
      onSaved(c)
    },
  })

  const applyUrl = (raw: string) => {
    setUrl(raw)
    const parsed = parseUrl(raw)
    if (parsed?.host) {
      setForm((f) => ({ ...f, ...parsed }))
      setTest(null)
    }
  }

  return (
    <Modal
      title={existing ? `Edit connection: ${existing.name}` : 'New connection'}
      onClose={onClose}
      footer={
        <>
          <button className="btn-outline mr-auto" onClick={() => testMut.mutate()} disabled={testMut.isPending}>
            {testMut.isPending && <Loader2 size={12} className="animate-spin" />} Test connection
          </button>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !form.host}>
            {saveMut.isPending && <Loader2 size={12} className="animate-spin" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Paste a connection string (optional)</label>
          <input
            className="input font-mono text-xs"
            placeholder="postgresql://user:password@host:5432/dbname?sslmode=require"
            value={url}
            onChange={(e) => applyUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Name</label>
          <input className="input" placeholder="My database" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="grid grid-cols-[1fr_100px] gap-2">
          <div>
            <label className="label">Host</label>
            <input className="input" value={form.host} onChange={(e) => set('host', e.target.value)} />
          </div>
          <div>
            <label className="label">Port</label>
            <input className="input" type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} />
          </div>
        </div>
        <p className="-mt-1 text-[11px] leading-4 text-zinc-500">
          The app runs in Docker: use <code className="text-zinc-300">host.docker.internal</code> for a database on
          this machine, not <code className="text-zinc-300">localhost</code>.
        </p>
        <div>
          <label className="label">Database</label>
          <input className="input" value={form.database} onChange={(e) => set('database', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Username</label>
            <input className="input" value={form.username} onChange={(e) => set('username', e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              placeholder={existing?.has_password ? '•••••• (unchanged)' : ''}
              value={form.password ?? ''}
              onChange={(e) => set('password', e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="label">SSL mode</label>
          <select className="input" value={form.sslmode} onChange={(e) => set('sslmode', e.target.value)}>
            {SSL_MODES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-zinc-500">Cloud providers (RDS, Supabase, Neon, Azure…) usually need “require”.</p>
        </div>
        {test && (
          <div
            className={`flex items-start gap-2 rounded-md border p-2 text-xs ${
              test.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'
            }`}
          >
            {test.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
            <span className="break-all">{test.ok ? `Connected · ${test.version?.split(',')[0]}` : test.error}</span>
          </div>
        )}
        {saveMut.error && <div className="text-xs text-red-300">{(saveMut.error as Error).message}</div>}
      </div>
    </Modal>
  )
}
