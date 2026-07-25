import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight, Search, PenSquare, FileText, Calendar, Package, Cpu, Loader2, Check,
} from 'lucide-react'

interface ToolPayload {
  name: string
  args?: Record<string, any>
  result?: string
  status?: 'running' | 'done'
}

const TOOL_ICONS: Record<string, any> = {
  search_memory: Search,
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

// A short one-line summary of the call's arguments, e.g. the search query.
function argSummary(p: ToolPayload): string {
  const a = p.args || {}
  const first = a.query ?? a.fact ?? a.path ?? a.task_description ?? a.from_date ?? ''
  return typeof first === 'string' ? first : ''
}

export default function ToolCallCard({ content }: { content: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const p = parse(content)
  if (!p) return null

  const Icon = TOOL_ICONS[p.name] || Cpu
  const running = p.status === 'running'
  const label = t(`toolCalls.${p.name}`, p.name)
  const summary = argSummary(p)
  const hasDetail = (p.args && Object.keys(p.args).length > 0) || !!p.result

  return (
    <div className="w-full max-w-3xl mx-auto">
      <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 overflow-hidden">
        <button
          onClick={() => hasDetail && setOpen(o => !o)}
          className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left ${hasDetail ? 'hover:bg-slate-100/70 cursor-pointer' : 'cursor-default'} transition-colors`}
        >
          <Icon className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          <span className="text-[13px] font-medium text-slate-700 flex-shrink-0">{label}</span>
          {summary && (
            <span className="text-xs text-slate-400 truncate flex-1 min-w-0">{summary}</span>
          )}
          <span className="ml-auto flex items-center gap-2 flex-shrink-0">
            {running ? (
              <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            )}
            {hasDetail && (
              <ChevronRight className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
            )}
          </span>
        </button>

        {open && hasDetail && (
          <div className="px-3.5 pb-3 pt-1 space-y-2.5 border-t border-slate-200/60">
            {p.args && Object.keys(p.args).length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                  {t('toolCalls.args')}
                </div>
                <pre className="text-[11px] leading-relaxed text-slate-600 bg-white border border-slate-200/70 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(p.args, null, 2)}
                </pre>
              </div>
            )}
            {p.result && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                  {t('toolCalls.result')}
                </div>
                <pre className="text-[11px] leading-relaxed text-slate-600 bg-white border border-slate-200/70 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-words">
                  {p.result}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
