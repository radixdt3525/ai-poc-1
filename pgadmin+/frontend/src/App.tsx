import { useQuery } from '@tanstack/react-query'
import { Bot, Database, Lightbulb, Sparkles } from 'lucide-react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { api } from './api/client'
import { ChatPanel } from './components/Chat/ChatPanel'
import { ConfirmDialog } from './components/common/ConfirmDialog'
import { ConnectionList } from './components/ConnectionManager/ConnectionList'
import { EditorPane } from './components/Editor/EditorPane'
import { InsightsPanel } from './components/Insights/InsightsPanel'
import { ResultsPane } from './components/Results/ResultsPane'
import { SchemaTree } from './components/SchemaTree/SchemaTree'
import { useStore } from './store'

function Handle({ vertical = false }: { vertical?: boolean }) {
  return (
    <PanelResizeHandle
      className={`${vertical ? 'h-1' : 'w-1'} bg-zinc-900 transition-colors hover:bg-sky-600 data-[resize-handle-state=drag]:bg-sky-500`}
    />
  )
}

function useActiveConnection() {
  const id = useStore((s) => s.activeConnectionId)
  const { data } = useQuery({ queryKey: ['connections'], queryFn: api.connections })
  return data?.find((c) => c.id === id) ?? null
}

function TopBar() {
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.config })
  const conn = useActiveConnection()
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4">
      <div className="flex items-center gap-2 font-semibold text-zinc-100">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-600">
          <Database size={14} className="text-white" />
        </div>
        pgAdmin<span className="-ml-1.5 text-sky-400">+</span>
      </div>
      <div className="h-5 w-px bg-zinc-800" />
      {conn ? (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-zinc-200">{conn.name}</span>
          <span className="font-mono">
            {conn.username}@{conn.host}:{conn.port}/{conn.database}
          </span>
        </div>
      ) : (
        <span className="text-xs text-zinc-500">No connection selected</span>
      )}
      <div className="ml-auto flex items-center gap-2 text-xs">
        {config &&
          (config.ai_enabled ? (
            <span className="flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-violet-300">
              <Sparkles size={12} /> AI · {config.model}
            </span>
          ) : (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-amber-300">
              AI disabled: set OPENAI_API_KEY
            </span>
          ))}
      </div>
    </header>
  )
}

function RightPanel() {
  const panel = useStore((s) => s.rightPanel)
  const setPanel = useStore((s) => s.setRightPanel)
  const connId = useStore((s) => s.activeConnectionId)
  const { data: insights } = useQuery({
    queryKey: ['insights', connId, 'open'],
    queryFn: () => api.insights(connId!, 'open'),
    enabled: !!connId,
    refetchInterval: 60_000,
  })
  const unread = insights?.unread ?? 0
  const tabCls = (active: boolean) =>
    `flex h-full items-center gap-1.5 border-b-2 px-3 text-xs font-medium ${
      active ? 'border-sky-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
    }`
  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex h-9 shrink-0 items-stretch border-b border-zinc-800 px-1">
        <button className={tabCls(panel === 'chat')} onClick={() => setPanel('chat')}>
          <Bot size={14} /> AI Assistant
        </button>
        <button className={tabCls(panel === 'insights')} onClick={() => setPanel('insights')}>
          <Lightbulb size={14} /> Insights
          {unread > 0 && (
            <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-bold leading-4 text-zinc-950">{unread}</span>
          )}
        </button>
      </div>
      {/* keep both mounted so a streaming chat survives switching tabs */}
      <div className={`min-h-0 flex-1 ${panel === 'chat' ? '' : 'hidden'}`}>
        <ChatPanel />
      </div>
      <div className={`min-h-0 flex-1 ${panel === 'insights' ? '' : 'hidden'}`}>
        <InsightsPanel />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <PanelGroup direction="horizontal" autoSaveId="pgplus.layout.h" className="min-h-0 flex-1">
        <Panel defaultSize={18} minSize={12} className="flex flex-col border-r border-zinc-800 bg-zinc-950">
          <ConnectionList />
          <div className="min-h-0 flex-1 overflow-auto">
            <SchemaTree />
          </div>
        </Panel>
        <Handle />
        <Panel defaultSize={52} minSize={30}>
          <PanelGroup direction="vertical" autoSaveId="pgplus.layout.v">
            <Panel defaultSize={55} minSize={20}>
              <EditorPane />
            </Panel>
            <Handle vertical />
            <Panel defaultSize={45} minSize={15}>
              <ResultsPane />
            </Panel>
          </PanelGroup>
        </Panel>
        <Handle />
        <Panel defaultSize={30} minSize={20} className="border-l border-zinc-800">
          <RightPanel />
        </Panel>
      </PanelGroup>
      <ConfirmDialog />
    </div>
  )
}
