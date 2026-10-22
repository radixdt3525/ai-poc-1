import Editor, { type OnMount } from '@monaco-editor/react'
import { useQuery } from '@tanstack/react-query'
import { AlignLeft, Gauge, Loader2, Play, Plus, Sparkles, Square, X, Zap } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { format } from 'sql-formatter'
import { api } from '../../api/client'
import { useActiveTab, useStore } from '../../store'
import { currentSql, setEditor } from './editorBridge'
import { monaco, registerSqlCompletion, setCompletionData } from './monacoSetup'

function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeTabId)
  const setActive = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const addTab = useStore((s) => s.addTab)
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-zinc-800 bg-zinc-950">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`group flex cursor-pointer items-center gap-2 border-r border-zinc-800 px-3 text-xs ${
            t.id === activeId ? 'bg-zinc-900 text-zinc-100 shadow-[inset_0_2px_0_#0ea5e9]' : 'text-zinc-400 hover:bg-zinc-900/50'
          }`}
          onClick={() => setActive(t.id)}
          onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
        >
          {t.running && <Loader2 size={11} className="animate-spin text-sky-400" />}
          <span className="max-w-[160px] truncate">{t.title}</span>
          <button
            className="rounded p-0.5 opacity-0 hover:bg-zinc-700 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              closeTab(t.id)
            }}
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <button className="px-2 text-zinc-500 hover:text-zinc-200" title="New query tab" onClick={() => addTab()}>
        <Plus size={14} />
      </button>
    </div>
  )
}

export function EditorPane() {
  const tab = useActiveTab()
  const updateTab = useStore((s) => s.updateTab)
  const runTab = useStore((s) => s.runTab)
  const cancelTab = useStore((s) => s.cancelTab)
  const explainTab = useStore((s) => s.explainTab)
  const askAI = useStore((s) => s.askAI)
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: api.connections })
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.config })

  const { data: completion } = useQuery({
    queryKey: ['completion', tab.connectionId],
    queryFn: () => api.completion(tab.connectionId!),
    enabled: !!tab.connectionId,
  })
  useEffect(() => setCompletionData(completion ?? []), [completion])

  // Keyboard shortcuts must always act on the current tab, so read it through a ref.
  const tabIdRef = useRef(tab.id)
  tabIdRef.current = tab.id

  const onMount: OnMount = (editor) => {
    setEditor(editor)
    registerSqlCompletion()
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runTab(tabIdRef.current, currentSql()))
    editor.addCommand(monaco.KeyCode.F5, () => runTab(tabIdRef.current, currentSql()))
    editor.addCommand(monaco.KeyCode.F7, () => explainTab(tabIdRef.current, false, currentSql()))
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => explainTab(tabIdRef.current, true, currentSql()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, formatSql)
  }
  useEffect(() => () => setEditor(null), [])

  function formatSql() {
    const t = useStore.getState().tabs.find((x) => x.id === tabIdRef.current)
    if (!t) return
    try {
      updateTab(t.id, { sql: format(t.sql, { language: 'postgresql', keywordCase: 'upper', tabWidth: 2 }) })
    } catch {
      /* leave unformattable SQL alone */
    }
  }

  const lastError = tab.result?.error
  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <TabBar />
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-zinc-800 px-2">
        {tab.running && tab.runId ? (
          <button className="btn-danger" onClick={() => cancelTab(tab.id)} title="Cancel running query">
            <Square size={12} /> Cancel
          </button>
        ) : (
          <button className="btn-primary" disabled={tab.running} onClick={() => runTab(tab.id, currentSql())} title="Run selection or all (Ctrl+Enter / F5)">
            {tab.running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run
          </button>
        )}
        <button className="btn-ghost" disabled={tab.running} onClick={() => explainTab(tab.id, false, currentSql())} title="Explain (F7)">
          <Zap size={12} /> Explain
        </button>
        <button className="btn-ghost" disabled={tab.running} onClick={() => explainTab(tab.id, true, currentSql())} title="Explain Analyze, rolled back afterwards (Shift+F7)">
          <Gauge size={12} /> Analyze
        </button>
        <button className="btn-ghost" onClick={formatSql} title="Format SQL (Ctrl+Shift+F)">
          <AlignLeft size={12} /> Format
        </button>
        {config?.ai_enabled && (
          <>
            <div className="mx-1 h-5 w-px bg-zinc-800" />
            <button
              className="btn-ghost text-violet-300 hover:text-violet-200"
              disabled={!tab.sql.trim()}
              onClick={() => askAI('Explain what this query does and suggest any improvements (correctness, performance, readability).', { includeEditor: true })}
            >
              <Sparkles size={12} /> Explain with AI
            </button>
            {lastError && (
              <button
                className="btn-ghost text-amber-300 hover:text-amber-200"
                onClick={() => askAI('Fix the error in my query.', { includeEditor: true, error: lastError.message })}
              >
                <Sparkles size={12} /> Fix with AI
              </button>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            className="input !w-auto !py-0.5 text-xs"
            value={tab.rowLimit}
            onChange={(e) => updateTab(tab.id, { rowLimit: Number(e.target.value) })}
            title="Max rows per statement"
          >
            {[100, 1000, 10000, 50000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} rows
              </option>
            ))}
          </select>
          <select
            className="input !w-44 !py-0.5 text-xs"
            value={tab.connectionId ?? ''}
            onChange={(e) => updateTab(tab.id, { connectionId: e.target.value || null })}
            title="Connection for this tab"
          >
            <option value="">— connection —</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          path={tab.id}
          language="pgsql"
          theme="pgplus"
          value={tab.sql}
          onChange={(v) => updateTab(tab.id, { sql: v ?? '' })}
          onMount={onMount}
          options={{
            fontSize: 13,
            fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            renderLineHighlight: 'all',
            padding: { top: 8 },
            suggest: { showWords: false },
            acceptSuggestionOnEnter: 'smart',
          }}
        />
      </div>
    </div>
  )
}
