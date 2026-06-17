import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'

const components: Components = {
  code({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
    const match = /language-(\w+)/.exec(className || '')
    const inline = !match
    if (inline) {
      return (
        <code className="font-mono text-[13px] bg-slate-100 text-slate-800 rounded-md px-1.5 py-0.5" {...props}>
          {children}
        </code>
      )
    }
    return (
      <div className="relative my-3">
        <div className="absolute right-3 top-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          {match![1]}
        </div>
        <pre className="bg-slate-900 text-slate-100 rounded-xl p-4 pt-8 overflow-x-auto text-[13px] leading-relaxed font-mono hljs">
          <code className={className} {...props}>{children}</code>
        </pre>
      </div>
    )
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-3 rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return <th className="bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-600 border-b border-slate-200">{children}</th>
  },
  td({ children }) {
    return <td className="px-3 py-2 border-b border-slate-100 text-slate-700">{children}</td>
  },
  blockquote({ children }) {
    return <blockquote className="border-l-2 border-slate-300 pl-4 italic text-slate-500 my-2">{children}</blockquote>
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline underline-offset-2 decoration-blue-300 hover:decoration-blue-500 transition-colors">
        {children}
      </a>
    )
  },
  hr() {
    return <hr className="my-4 border-slate-200" />
  },
  ul({ children }) {
    return <ul className="list-disc list-outside pl-5 my-2 space-y-1 text-slate-700">{children}</ul>
  },
  ol({ children }) {
    return <ol className="list-decimal list-outside pl-5 my-2 space-y-1 text-slate-700">{children}</ol>
  },
}

export default function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeKatex, rehypeHighlight]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  )
}
