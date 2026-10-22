import { create } from 'zustand'
import { api } from './api/client'
import type { DestructiveStatement, ExecResult, ExplainResult } from './api/types'

export type ResultView = 'data' | 'messages' | 'plan' | 'history'

export interface Tab {
  id: string
  title: string
  sql: string
  connectionId: string | null
  rowLimit: number
  running: boolean
  runId?: string
  result?: ExecResult
  resultIndex: number
  explain?: ExplainResult
  requestError?: string
  view: ResultView
}

export interface ChatDraft {
  text: string
  includeEditor: boolean
  error?: string | null
  nonce: number
}

interface ConfirmRequest {
  statements: DestructiveStatement[]
  resolve: (ok: boolean) => void
}

interface State {
  activeConnectionId: string | null
  tabs: Tab[]
  activeTabId: string
  rightPanel: 'chat' | 'insights'
  chatDraft: ChatDraft | null
  confirm: ConfirmRequest | null
  schemaVersion: number

  setActiveConnection: (id: string | null) => void
  addTab: (init?: Partial<Tab>) => string
  closeTab: (id: string) => void
  updateTab: (id: string, patch: Partial<Tab>) => void
  setActiveTab: (id: string) => void
  setRightPanel: (p: 'chat' | 'insights') => void
  askAI: (text: string, opts?: { includeEditor?: boolean; error?: string | null }) => void
  clearChatDraft: () => void
  resolveConfirm: (ok: boolean) => void
  bumpSchema: () => void

  runTab: (id: string, sqlOverride?: string) => Promise<void>
  cancelTab: (id: string) => Promise<void>
  explainTab: (id: string, analyze: boolean, sqlOverride?: string) => Promise<void>
}

const uid = () => Math.random().toString(36).slice(2, 10)
const savedConnection = (() => {
  try {
    return localStorage.getItem('pgplus.activeConnection')
  } catch {
    return null
  }
})()

let tabCounter = 1
const newTab = (init: Partial<Tab> = {}, connectionId: string | null = null): Tab => ({
  id: uid(),
  title: `Query ${tabCounter++}`,
  sql: '',
  connectionId,
  rowLimit: 1000,
  running: false,
  resultIndex: 0,
  view: 'data',
  ...init,
})

const firstTab = newTab({}, savedConnection)

export const useStore = create<State>((set, get) => {
  const patchTab = (id: string, patch: Partial<Tab>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  const getTab = (id: string) => get().tabs.find((t) => t.id === id)

  return {
    activeConnectionId: savedConnection,
    tabs: [firstTab],
    activeTabId: firstTab.id,
    rightPanel: 'chat',
    chatDraft: null,
    confirm: null,
    schemaVersion: 0,

    setActiveConnection: (id) => {
      try {
        if (id) localStorage.setItem('pgplus.activeConnection', id)
        else localStorage.removeItem('pgplus.activeConnection')
      } catch {
        /* storage unavailable */
      }
      set((s) => ({
        activeConnectionId: id,
        // tabs without a connection follow the active one
        tabs: s.tabs.map((t) => (t.connectionId ? t : { ...t, connectionId: id })),
      }))
    },
    addTab: (init) => {
      const tab = newTab(init, init?.connectionId ?? get().activeConnectionId)
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
      return tab.id
    },
    closeTab: (id) =>
      set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== id)
        if (!tabs.length) tabs.push(newTab({}, s.activeConnectionId))
        const activeTabId = s.activeTabId === id ? tabs[Math.max(0, s.tabs.findIndex((t) => t.id === id) - 1)].id : s.activeTabId
        return { tabs, activeTabId: tabs.some((t) => t.id === activeTabId) ? activeTabId : tabs[0].id }
      }),
    updateTab: patchTab,
    setActiveTab: (id) => set({ activeTabId: id }),
    setRightPanel: (p) => set({ rightPanel: p }),
    askAI: (text, opts) =>
      set({
        rightPanel: 'chat',
        chatDraft: { text, includeEditor: !!opts?.includeEditor, error: opts?.error, nonce: Date.now() },
      }),
    clearChatDraft: () => set({ chatDraft: null }),
    resolveConfirm: (ok) => {
      get().confirm?.resolve(ok)
      set({ confirm: null })
    },
    bumpSchema: () => set((s) => ({ schemaVersion: s.schemaVersion + 1 })),

    runTab: async (id, sqlOverride) => {
      const tab = getTab(id)
      if (!tab || tab.running) return
      if (!tab.connectionId) {
        patchTab(id, { requestError: 'Select a connection first.', view: 'messages' })
        return
      }
      const sql = (sqlOverride ?? tab.sql).trim()
      if (!sql) return
      const runId = uid()
      const conn = tab.connectionId
      patchTab(id, { running: true, runId, requestError: undefined })
      try {
        let res = await api.runQuery(conn, { sql, run_id: runId, row_limit: tab.rowLimit })
        if (res.kind === 'confirm') {
          const ok = await new Promise<boolean>((resolve) => set({ confirm: { statements: res.kind === 'confirm' ? res.statements : [], resolve } }))
          if (!ok) return
          res = await api.runQuery(conn, { sql, run_id: runId, row_limit: tab.rowLimit, confirm_destructive: true })
        }
        if (res.kind !== 'result') return
        const data = res.data
        const lastWithRows = data.results.map((r) => r.columns.length > 0).lastIndexOf(true)
        patchTab(id, {
          result: data,
          resultIndex: Math.max(lastWithRows, 0),
          view: data.error || lastWithRows === -1 ? 'messages' : 'data',
        })
        if (data.schema_changed) get().bumpSchema()
      } catch (e) {
        patchTab(id, { requestError: (e as Error).message, result: undefined, view: 'messages' })
      } finally {
        patchTab(id, { running: false, runId: undefined })
      }
    },

    cancelTab: async (id) => {
      const tab = getTab(id)
      if (tab?.connectionId && tab.runId) await api.cancelQuery(tab.connectionId, tab.runId)
    },

    explainTab: async (id, analyze, sqlOverride) => {
      const tab = getTab(id)
      if (!tab || tab.running) return
      if (!tab.connectionId) {
        patchTab(id, { requestError: 'Select a connection first.', view: 'messages' })
        return
      }
      const sql = (sqlOverride ?? tab.sql).trim()
      if (!sql) return
      patchTab(id, { running: true, requestError: undefined })
      try {
        const explain = await api.explain(tab.connectionId, sql, analyze)
        patchTab(id, { explain, view: 'plan' })
      } catch (e) {
        patchTab(id, { requestError: (e as Error).message, view: 'messages' })
      } finally {
        patchTab(id, { running: false })
      }
    },
  }
})

export const useActiveTab = () => useStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0])
