import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Braces,
  ChevronRight,
  Columns3,
  Eye,
  FileCode2,
  FolderTree,
  Hash,
  KeyRound,
  Layers,
  Link2,
  ListOrdered,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Table2,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../../api/client'
import type { RelationSummary } from '../../api/types'
import { useStore } from '../../store'
import { formatBytes, formatCount, qualified } from '../common/format'

function Node({
  label,
  icon,
  depth,
  children,
  meta,
  actions,
  defaultOpen = false,
  leaf = false,
  title,
}: {
  label: ReactNode
  icon: ReactNode
  depth: number
  children?: (open: boolean) => ReactNode
  meta?: ReactNode
  actions?: ReactNode
  defaultOpen?: boolean
  leaf?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <div
        className="group flex h-6 cursor-pointer select-none items-center gap-1 pr-2 text-zinc-300 hover:bg-zinc-900"
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() => !leaf && setOpen(!open)}
        title={title}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-90' : ''} ${leaf ? 'invisible' : ''}`}
        />
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
        {meta && <span className="ml-1 shrink-0 text-[10px] text-zinc-500">{meta}</span>}
        {actions && <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">{actions}</span>}
      </div>
      {open && children?.(open)}
    </div>
  )
}

function Loading({ depth }: { depth: number }) {
  return (
    <div className="flex h-6 items-center gap-1 text-zinc-500" style={{ paddingLeft: depth * 12 + 20 }}>
      <Loader2 size={12} className="animate-spin" /> loading…
    </div>
  )
}

function ErrorRow({ depth, error }: { depth: number; error: unknown }) {
  return (
    <div className="px-2 py-1 text-xs text-red-300" style={{ paddingLeft: depth * 12 + 20 }}>
      {(error as Error).message}
    </div>
  )
}

function RelationDetailsNode({ connId, schema, name, depth }: { connId: string; schema: string; name: string; depth: number }) {
  const version = useStore((s) => s.schemaVersion)
  const { data, isLoading, error } = useQuery({
    queryKey: ['relation', connId, schema, name, version],
    queryFn: () => api.relation(connId, schema, name),
  })
  if (isLoading) return <Loading depth={depth} />
  if (error) return <ErrorRow depth={depth} error={error} />
  if (!data) return null
  const pkCols = new Set(
    data.constraints
      .filter((c) => c.type === 'p')
      .flatMap((c) => c.definition.replace(/^PRIMARY KEY \((.*)\).*$/, '$1').split(',').map((s) => s.trim().replace(/"/g, ''))),
  )
  return (
    <>
      <Node label="Columns" icon={<Columns3 size={12} className="text-zinc-500" />} depth={depth} meta={data.columns.length} defaultOpen>
        {() =>
          data.columns.map((c) => (
            <Node
              key={c.name}
              leaf
              depth={depth + 1}
              icon={pkCols.has(c.name) ? <KeyRound size={11} className="text-amber-400" /> : <Hash size={11} className="text-zinc-500" />}
              label={c.name}
              meta={`${c.type}${c.not_null ? '' : ' ?'}`}
              title={c.comment ?? undefined}
            />
          ))
        }
      </Node>
      {data.indexes.length > 0 && (
        <Node label="Indexes" icon={<ListOrdered size={12} className="text-zinc-500" />} depth={depth} meta={data.indexes.length}>
          {() =>
            data.indexes.map((i) => (
              <Node
                key={i.name}
                leaf
                depth={depth + 1}
                icon={<ListOrdered size={11} className={i.is_valid ? 'text-violet-400' : 'text-red-400'} />}
                label={i.name}
                meta={`${formatBytes(i.bytes)} · ${i.scans ?? 0} scans`}
                title={i.definition}
              />
            ))
          }
        </Node>
      )}
      {data.constraints.length > 0 && (
        <Node label="Constraints" icon={<Link2 size={12} className="text-zinc-500" />} depth={depth} meta={data.constraints.length}>
          {() =>
            data.constraints.map((c) => (
              <Node
                key={c.name}
                leaf
                depth={depth + 1}
                icon={<Link2 size={11} className="text-zinc-500" />}
                label={c.name}
                title={c.definition}
                meta={{ p: 'PK', u: 'UNIQUE', f: 'FK', c: 'CHECK', x: 'EXCL' }[c.type] ?? c.type}
              />
            ))
          }
        </Node>
      )}
    </>
  )
}

function RelationNode({ connId, schema, rel, depth, icon }: { connId: string; schema: string; rel: RelationSummary; depth: number; icon: ReactNode }) {
  const addTab = useStore((s) => s.addTab)
  const runTab = useStore((s) => s.runTab)
  const askAI = useStore((s) => s.askAI)
  const target = qualified(schema, rel.name)
  const selectTop = (e: React.MouseEvent) => {
    e.stopPropagation()
    const id = addTab({ title: rel.name, sql: `SELECT * FROM ${target}\nLIMIT 100;`, connectionId: connId })
    void runTab(id)
  }
  const scriptCreate = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const details = await api.relation(connId, schema, rel.name)
    addTab({ title: `${rel.name} DDL`, sql: details.ddl, connectionId: connId })
  }
  const ask = (e: React.MouseEvent) => {
    e.stopPropagation()
    askAI(`Give me an overview of ${schema}.${rel.name}: what it stores, its relationships, data quality and any index or schema improvements.`)
  }
  return (
    <Node
      depth={depth}
      icon={icon}
      label={rel.name}
      meta={rel.kind === 'S' ? undefined : `${formatCount(rel.row_estimate)} rows`}
      title={rel.comment ?? `${formatBytes(rel.total_bytes)}`}
      leaf={rel.kind === 'S'}
      actions={
        rel.kind !== 'S' && (
          <>
            <button className="icon-btn !h-5 !w-5" title="SELECT top 100" onClick={selectTop}>
              <Play size={11} />
            </button>
            <button className="icon-btn !h-5 !w-5" title="Script as CREATE" onClick={scriptCreate}>
              <FileCode2 size={11} />
            </button>
            <button className="icon-btn !h-5 !w-5 hover:!text-violet-300" title="Ask AI about this" onClick={ask}>
              <Sparkles size={11} />
            </button>
          </>
        )
      }
    >
      {() => <RelationDetailsNode connId={connId} schema={schema} name={rel.name} depth={depth + 1} />}
    </Node>
  )
}

function SchemaNode({ connId, schema, depth, defaultOpen }: { connId: string; schema: string; depth: number; defaultOpen: boolean }) {
  return (
    <Node depth={depth} icon={<Layers size={13} className="text-sky-400" />} label={schema} defaultOpen={defaultOpen}>
      {() => <SchemaObjectsList connId={connId} schema={schema} depth={depth + 1} />}
    </Node>
  )
}

function SchemaObjectsList({ connId, schema, depth }: { connId: string; schema: string; depth: number }) {
  const version = useStore((s) => s.schemaVersion)
  const addTab = useStore((s) => s.addTab)
  const { data, isLoading, error } = useQuery({
    queryKey: ['objects', connId, schema, version],
    queryFn: () => api.objects(connId, schema),
  })
  if (isLoading) return <Loading depth={depth} />
  if (error) return <ErrorRow depth={depth} error={error} />
  if (!data) return null
  const groups: { key: keyof typeof data; label: string; icon: ReactNode }[] = [
    { key: 'tables', label: 'Tables', icon: <Table2 size={12} className="text-emerald-400" /> },
    { key: 'views', label: 'Views', icon: <Eye size={12} className="text-cyan-400" /> },
    { key: 'materialized_views', label: 'Materialized views', icon: <Eye size={12} className="text-teal-400" /> },
    { key: 'foreign_tables', label: 'Foreign tables', icon: <Table2 size={12} className="text-orange-400" /> },
    { key: 'sequences', label: 'Sequences', icon: <Hash size={12} className="text-zinc-400" /> },
  ]
  return (
    <>
      {groups.map(({ key, label, icon }) => {
        const items = data[key] as RelationSummary[]
        if (!items.length) return null
        return (
          <Node key={key} depth={depth} icon={<FolderTree size={12} className="text-zinc-500" />} label={label} meta={items.length} defaultOpen={key === 'tables'}>
            {() => items.map((rel) => <RelationNode key={rel.name} connId={connId} schema={schema} rel={rel} depth={depth + 1} icon={icon} />)}
          </Node>
        )
      })}
      {data.functions.length > 0 && (
        <Node depth={depth} icon={<FolderTree size={12} className="text-zinc-500" />} label="Functions" meta={data.functions.length}>
          {() =>
            data.functions.map((f) => (
              <div
                key={`${f.name}(${f.args})`}
                className="flex h-6 cursor-pointer items-center gap-1 truncate pr-2 text-zinc-300 hover:bg-zinc-900"
                style={{ paddingLeft: (depth + 1) * 12 + 18 }}
                title={`${f.name}(${f.args}) → ${f.result}\nClick to open a call template`}
                onClick={() => addTab({ title: f.name, sql: `SELECT ${qualified(schema, f.name)}(${f.args});`, connectionId: connId })}
              >
                <Braces size={11} className="shrink-0 text-pink-400" />
                <span className="truncate">{f.name}</span>
                <span className="truncate text-[10px] text-zinc-500">({f.args})</span>
              </div>
            ))
          }
        </Node>
      )}
    </>
  )
}

export function SchemaTree() {
  const connId = useStore((s) => s.activeConnectionId)
  const version = useStore((s) => s.schemaVersion)
  const bump = useStore((s) => s.bumpSchema)
  const qc = useQueryClient()
  const { data: schemas, isLoading, error, refetch } = useQuery({
    queryKey: ['schemas', connId, version],
    queryFn: () => api.schemas(connId!),
    enabled: !!connId,
  })

  useEffect(() => {
    if (connId) qc.invalidateQueries({ queryKey: ['completion', connId] })
  }, [version, connId, qc])

  if (!connId) return <div className="p-3 text-xs text-zinc-500">Select or add a connection to browse its schema.</div>

  return (
    <div className="pb-4">
      <div className="panel-header">
        Browser
        <button
          className="icon-btn ml-auto"
          title="Refresh"
          onClick={async () => {
            await api.refreshSchema(connId)
            bump()
            void refetch()
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      {isLoading && <Loading depth={0} />}
      {error && <div className="p-3 text-xs text-red-300">{(error as Error).message}</div>}
      {schemas?.map((s) => (
        <SchemaNode key={s.name} connId={connId} schema={s.name} depth={0} defaultOpen={s.name === 'public'} />
      ))}
    </div>
  )
}
