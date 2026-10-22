import type * as Monaco from 'monaco-editor'
import { useStore } from '../../store'

/** The live Monaco editor, so other panels (chat, insights) can insert SQL at the cursor. */
let editor: Monaco.editor.IStandaloneCodeEditor | null = null

export function setEditor(e: Monaco.editor.IStandaloneCodeEditor | null) {
  editor = e
}

export function getEditor() {
  return editor
}

/** Text to run: the selection if there is one, otherwise the whole editor. */
export function currentSql(): string | undefined {
  if (!editor) return undefined
  const model = editor.getModel()
  const sel = editor.getSelection()
  if (model && sel && !sel.isEmpty()) return model.getValueInRange(sel)
  return model?.getValue()
}

export function insertIntoEditor(sql: string) {
  const { tabs, activeTabId, updateTab } = useStore.getState()
  const tab = tabs.find((t) => t.id === activeTabId)
  if (!editor || !tab) {
    if (tab) updateTab(tab.id, { sql: tab.sql ? `${tab.sql}\n\n${sql}` : sql })
    return
  }
  const model = editor.getModel()
  if (!model) return
  const text = sql.trim().endsWith(';') ? sql.trim() : `${sql.trim()};`
  if (!model.getValue().trim()) {
    model.setValue(text)
  } else {
    const sel = editor.getSelection()!
    const prefix = sel.isEmpty() && sel.startColumn > 1 ? '\n\n' : ''
    editor.executeEdits('ai-insert', [{ range: sel, text: `${prefix}${text}\n`, forceMoveMarkers: true }])
  }
  editor.focus()
}
