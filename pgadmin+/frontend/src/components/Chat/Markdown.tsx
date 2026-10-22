import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SqlBlock } from '../common/SqlBlock'

const SQL_LANGS = new Set(['sql', 'postgres', 'postgresql', 'pgsql', 'plpgsql', 'psql'])

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const content = String(children ?? '').replace(/\n$/, '')
            const lang = /language-(\w+)/.exec(className ?? '')?.[1]?.toLowerCase()
            if (lang && SQL_LANGS.has(lang)) return <SqlBlock sql={content} />
            if (lang || content.includes('\n')) {
              return (
                <pre className="my-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[12px] text-zinc-300">
                  {content}
                </pre>
              )
            }
            return <code>{children}</code>
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
