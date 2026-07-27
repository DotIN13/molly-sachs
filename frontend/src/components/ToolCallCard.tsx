import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight, Search, TextSearch, PenSquare, FileText, Calendar, Package, Cpu, Loader2,
} from 'lucide-react'
import Markdown from './Markdown'

interface ToolPayload {
  name: string
  args?: Record<string, any>
  result?: string
  status?: 'running' | 'done'
}

const TOOL_ICONS: Record<string, any> = {
  search_memory: Search,
  grep_memory: TextSearch,
  add_memory: PenSquare,
  read_memory_page: FileText,
  fetch_calendar: Calendar,
  list_artifacts: Package,
  run_task: Cpu,
}

function parse(content: string): ToolPayload | null {
  try {
    const p = JSON.parse(content)
    if (p && typeof p.name === 'string') return p
  } catch { /* not a tool payload */ }
  return null
}

/** Markdown inside a tool call: the shared component is sized for the chat
 *  transcript, which is far roomier than this. */
function CardMarkdown({ content }: { content: string }) {
  return (
    <div
      className="text-[11px] leading-relaxed text-slate-500 overflow-x-auto
                 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:pl-4 [&_ol]:pl-4
                 [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-[11px]
                 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold
                 [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2 [&_h1]:mb-0.5 [&_h2]:mb-0.5 [&_h3]:mb-0.5
                 [&_pre]:my-1.5 [&_pre]:p-2.5 [&_pre]:pt-6 [&_pre]:rounded-lg [&_pre]:text-[10px]
                 [&_code]:text-[10px] [&_table]:my-1.5 [&_hr]:my-2
                 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    >
      <Markdown content={content} />
    </div>
  )
}

interface MemoryHit { category: string; title: string; snippet: string }

/** Split a `[category] title: snippet` result into one entry per memory.
 *
 *  The backend emits exactly one line per hit with internal whitespace
 *  collapsed. Returns null when the result isn't in that shape — a plain
 *  string, an error, or another tool's output — so the caller falls back to
 *  rendering it verbatim. */
function parseMemoryHits(result?: string): MemoryHit[] | null {
  if (!result) return null
  const lines = result.split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return null

  const hits: MemoryHit[] = []
  for (const line of lines) {
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line)
    if (!m) return null            // any non-conforming line: not a hit list
    const rest = m[2]
    const sep = rest.indexOf(': ')
    hits.push({
      category: m[1],
      title: sep === -1 ? rest : rest.slice(0, sep),
      snippet: sep === -1 ? '' : rest.slice(sep + 2),
    })
  }
  return hits.length ? hits : null
}

/** True when the result is grep output — a page path on its own line followed
 *  by `12: text` matches and `13- text` context lines. Rendered as a code block
 *  so the line breaks and line numbers survive the markdown pass. */
function isGrepOutput(result?: string): boolean {
  if (!result) return false
  const lines = result.split('\n')
  return lines.some(l => /^\d+[:-]/.test(l)) && lines.some(l => /\.md$/.test(l.trim()))
}

/** What the model passed in, as something readable.
 *
 *  Not a JSON block: these are one or two short strings, and pretty-printing
 *  them as an object buries the only part that matters in braces and quotes.
 *  A lone argument is shown on its own — the tool's name already says what it
 *  is — and several are laid out as labelled rows. */
function ArgValues({ args }: { args: Record<string, any> }) {
  const { t } = useTranslation()
  const entries = Object.entries(args).filter(
    ([, v]) => v !== null && v !== undefined && v !== '')
  if (!entries.length) return null

  const text = (v: any) => typeof v === 'string' ? v : JSON.stringify(v)

  if (entries.length === 1) {
    return (
      <p className="text-[11px] leading-relaxed text-slate-600 break-words whitespace-pre-wrap">
        {text(entries[0][1])}
      </p>
    )
  }
  return (
    <dl className="flex flex-col gap-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2 text-[11px] leading-relaxed">
          <dt className="flex-shrink-0 w-20 text-slate-400">
            {t(`toolCalls.arg.${key}`, { defaultValue: key })}
          </dt>
          <dd className="min-w-0 flex-1 text-slate-600 break-words whitespace-pre-wrap">
            {text(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export default function ToolCallCard({ content }: { content: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const p = parse(content)
  if (!p) return null

  const Icon = TOOL_ICONS[p.name] || Cpu
  const running = p.status === 'running'
  const label = t(`toolCalls.${p.name}`, p.name)
  const args = p.args && Object.keys(p.args).length > 0 ? p.args : null
  const hasDetail = !!args || !!p.result
  const items = parseMemoryHits(p.result)

  return (
    /* px-4 to match the horizontal padding on the chat bubbles, so this line
       starts exactly where the assistant's text does. The transcript already
       centres and width-limits its children, so no wrapper for that here. */
    <div className="px-4">
      {/* One quiet line, no frame. The transcript around it is the content;
          this is a footnote about how it was found. */}
      <button
        onClick={() => hasDetail && setOpen(o => !o)}
        className={`flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors
                    ${hasDetail ? 'hover:text-slate-600 cursor-pointer' : 'cursor-default'}`}
      >
        <Icon className="w-3 h-3 flex-shrink-0" />
        <span>{label}</span>
        {running && <Loader2 className="w-3 h-3 animate-spin" />}
        {hasDetail && (
          <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        )}
      </button>

      {open && hasDetail && (
        /* A rule down the left instead of a box: it groups the detail with the
           line that opened it without drawing another container. */
        <div className="mt-2 ml-1.5 pl-3 border-l border-slate-200 flex flex-col gap-2.5">
          {args && <ArgValues args={args} />}

          {p.result && (
            items ? (
              <ul className="flex flex-col gap-1.5">
                {items.map((it, i) => (
                  <li key={i} className="text-[11px] leading-relaxed">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[9px] uppercase tracking-wide text-slate-400 flex-shrink-0">
                        {it.category}
                      </span>
                      {it.title && (
                        <span className="font-medium text-slate-600 break-words">{it.title}</span>
                      )}
                    </div>
                    {it.snippet && (
                      <p className="text-slate-500 break-words">{it.snippet}</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : isGrepOutput(p.result) ? (
              <CardMarkdown content={'```text\n' + p.result + '\n```'} />
            ) : (
              // read_memory_page returns a memory page's raw markdown, and
              // the calendar/artifact results are markdown-ish too.
              <CardMarkdown content={p.result} />
            )
          )}
        </div>
      )}
    </div>
  )
}
