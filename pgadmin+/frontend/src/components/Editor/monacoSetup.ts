import { loader } from '@monaco-editor/react'
// Editor core + PostgreSQL highlighting only (the full 'monaco-editor' entry bundles ~80 languages).
import 'monaco-editor/esm/vs/editor/edcore.main'
import 'monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { CompletionRelation } from '../../api/types'

// Bundle Monaco locally instead of loading it from a CDN.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

monaco.editor.defineTheme('pgplus', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7dd3fc', fontStyle: 'bold' },
    { token: 'string', foreground: 'fcd34d' },
    { token: 'number', foreground: 'c4b5fd' },
    { token: 'comment', foreground: '71717a', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': '#09090b',
    'editor.lineHighlightBackground': '#18181b',
    'editorLineNumber.foreground': '#3f3f46',
    'editorGutter.background': '#09090b',
  },
})

const KEYWORDS = `SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS JOIN LEFT RIGHT FULL INNER OUTER CROSS
LATERAL ON USING GROUP BY ORDER ASC DESC NULLS FIRST LAST HAVING LIMIT OFFSET DISTINCT AS WITH RECURSIVE UNION ALL
INTERSECT EXCEPT INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE INDEX CONCURRENTLY VIEW MATERIALIZED
ALTER ADD COLUMN DROP CONSTRAINT PRIMARY KEY FOREIGN REFERENCES UNIQUE CHECK DEFAULT TRUNCATE CASCADE BEGIN COMMIT
ROLLBACK EXPLAIN ANALYZE VERBOSE BUFFERS VACUUM CASE WHEN THEN ELSE END CAST COALESCE NULLIF COUNT SUM AVG MIN MAX
NOW CURRENT_DATE CURRENT_TIMESTAMP INTERVAL OVER PARTITION WINDOW FILTER ON CONFLICT DO NOTHING EXTENSION SCHEMA
GRANT REVOKE FUNCTION RETURNS LANGUAGE TRIGGER IF`.split(/\s+/)

let relations: CompletionRelation[] = []

export function setCompletionData(data: CompletionRelation[]) {
  relations = data
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`
const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s.toLowerCase() === s ? s : s.toLowerCase())

function findRelation(name: string, schema?: string): CompletionRelation | undefined {
  const n = unquote(name)
  const s = schema ? unquote(schema) : undefined
  return (
    relations.find((r) => r.name === n && (!s || r.schema === s)) ??
    relations.find((r) => r.name.toLowerCase() === n.toLowerCase() && (!s || r.schema.toLowerCase() === s.toLowerCase()))
  )
}

/** alias -> relation for FROM/JOIN clauses in the text. */
function aliasMap(text: string): Map<string, CompletionRelation> {
  const map = new Map<string, CompletionRelation>()
  const re = new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:(${IDENT})\.)?(${IDENT})(?:\s+(?:AS\s+)?(${IDENT}))?`, 'gi')
  for (const m of text.matchAll(re)) {
    const rel = findRelation(m[2], m[1])
    if (!rel) continue
    map.set(unquote(m[2]).toLowerCase(), rel)
    const alias = m[3]
    if (alias && !KEYWORDS.includes(alias.toUpperCase())) map.set(unquote(alias).toLowerCase(), rel)
  }
  return map
}

let registered = false
export function registerSqlCompletion() {
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider('pgsql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn))
      const K = monaco.languages.CompletionItemKind
      const text = model.getValue()

      // "qualifier." -> columns of that table/alias, or relations of that schema
      const dot = before.match(new RegExp(`(${IDENT})\\.$`))
      if (dot) {
        const q = unquote(dot[1]).toLowerCase()
        const rel = aliasMap(text).get(q) ?? findRelation(dot[1])
        if (rel) {
          return { suggestions: rel.columns.map((c) => ({ label: c, kind: K.Field, insertText: c, range, detail: rel.name })) }
        }
        const inSchema = relations.filter((r) => r.schema.toLowerCase() === q)
        return { suggestions: inSchema.map((r) => ({ label: r.name, kind: K.Struct, insertText: r.name, range, detail: r.kind })) }
      }

      const used = new Set(aliasMap(text).values())
      const suggestions: monaco.languages.CompletionItem[] = [
        ...KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: `3${k}` })),
        ...relations.map((r) => ({
          label: r.schema === 'public' ? r.name : `${r.schema}.${r.name}`,
          kind: r.kind === 'v' || r.kind === 'm' ? K.Interface : K.Struct,
          insertText: r.schema === 'public' ? r.name : `${r.schema}.${r.name}`,
          detail: `${r.kind === 'v' ? 'view' : r.kind === 'm' ? 'mat. view' : 'table'} · ${r.columns.length} cols`,
          range,
          sortText: `2${r.name}`,
        })),
        ...[...used].flatMap((r) =>
          r.columns.map((c) => ({ label: c, kind: K.Field, insertText: c, detail: r.name, range, sortText: `1${c}` })),
        ),
      ]
      return { suggestions }
    },
  })
}

export { monaco }
