import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import EmptyState from './EmptyState'
import Markdown from './Markdown'
import { fetchHypogumRuns, fetchHypogumRunEvents, abortHypogumRun, fetchHypogumAgentStatus } from '../hypogum'

const TERMINAL = new Set(['done', 'error', 'timeout', 'aborted'])
const MEMORY_KINDS = new Set(['ingest', 'plan'])

function statusColor(s: string): string {
  if (s === 'done') return 'bg-emerald-50 text-emerald-700 border-emerald-100'
  if (s === 'running' || s === 'queued') return 'bg-blue-50 text-blue-700 border-blue-100'
  if (TERMINAL.has(s)) return 'bg-red-50 text-red-700 border-red-100'
  return 'bg-slate-100 text-slate-600 border-slate-200'
}

// Pull a tool name + a concise target out of an opencode tool part.
function toolInfo(part: any): { name: string; detail: string; status: string } {
  const st = part?.state || {}
  const input = st.input || part?.input || {}
  const name = part?.tool || st.tool || 'tool'
  let detail = st.title || ''
  if (!detail) {
    detail = input.filePath || input.path || input.command || input.pattern
      || input.url || input.query || input.description || ''
    if (!detail && typeof input === 'object') {
      const first = Object.values(input).find(v => typeof v === 'string')
      detail = (first as string) || ''
    }
  }
  return { name, detail: String(detail).replace(/\s+/g, ' ').trim().slice(0, 120), status: st.status || 'completed' }
}

// Render one normalized run event as an opencode-transcript-style row.
function EventRow({ ev }: { ev: any }) {
  const p = ev?.payload ?? ev ?? {}
  const type = p.type || ev?.type
  if (type === 'text') {
    return <div className="text-[12px] text-slate-700 leading-relaxed py-1.5"><Markdown content={p.text} /></div>
  }
  if (type === 'tool_use') {
    const { name, detail, status } = toolInfo(p.part)
    return (
      <div className="flex items-center gap-2 py-0.5 font-mono text-[11px]">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status === 'error' ? 'bg-red-500' : 'bg-emerald-500'}`} />
        <span className="font-semibold text-slate-700 shrink-0">{name}</span>
        {detail && <span className="text-slate-400 truncate">{detail}</span>}
      </div>
    )
  }
  if (type === 'step_finish') return <div className="border-t border-slate-100 my-1.5" />
  if (type === 'log') return <div className="text-[10px] font-mono text-slate-400 py-0.5">{p.text}</div>
  if (type === 'error') return <div className="text-[11px] text-red-600 whitespace-pre-wrap py-1">{p.error || p.text}</div>
  if (type === '__done__') {
    return (
      <div className={`mt-2 text-[10px] font-bold uppercase tracking-wider ${p.status === 'done' ? 'text-emerald-600' : 'text-red-600'}`}>
        {p.status === 'done' ? '✓ done' : `✕ ${p.status || 'ended'}`}
      </div>
    )
  }
  return <div className="text-[11px] font-mono text-slate-500 py-0.5">{type}</div>
}

export default function WorkTab() {
  const { t } = useTranslation()
  const [sub, setSub] = useState<'memory' | 'worker'>('memory')
  const [runs, setRuns] = useState<any[]>([])
  const [selRun, setSelRun] = useState<string | null>(null)
  const [runEvents, setRunEvents] = useState<any[]>([])
  const [status, setStatus] = useState<any | null>(null)
  const eventsCursor = useRef(0)

  const loadRuns = async () => { try { setRuns(await fetchHypogumRuns()) } catch { /* offline */ } }
  const loadStatus = async () => { setStatus(await fetchHypogumAgentStatus()) }

  useEffect(() => {
    loadRuns(); loadStatus()
    const t1 = setInterval(loadRuns, 4000)
    const t2 = setInterval(loadStatus, 10000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [])

  // Poll the selected run's events incrementally.
  useEffect(() => {
    if (!selRun) return
    setRunEvents([]); eventsCursor.current = 0
    let stop = false
    const poll = async () => {
      try {
        const evs = await fetchHypogumRunEvents(selRun, eventsCursor.current)
        if (stop) return
        if (evs.length) {
          eventsCursor.current = evs[evs.length - 1].seq ?? eventsCursor.current
          setRunEvents(prev => [...prev, ...evs])
        }
      } catch { /* ignore */ }
    }
    poll()
    const timer = setInterval(poll, 2000)
    return () => { stop = true; clearInterval(timer) }
  }, [selRun])

  const shown = runs.filter(r => sub === 'memory' ? MEMORY_KINDS.has(r.kind) : r.kind === 'task')
  const selRunObj = runs.find(r => r.id === selRun)
  const canAbort = !!selRunObj && !TERMINAL.has(selRunObj.status)

  return (
    <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
      <div className="max-w-5xl mx-auto w-full animate-in fade-in duration-300">
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          {/* Memory / Worker sub-tabs */}
          <div className="flex bg-slate-100 rounded-lg p-0.5 border border-slate-200/60">
            {(['memory', 'worker'] as const).map(s => (
              <button key={s} onClick={() => { setSub(s); setSelRun(null) }} className={`text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${sub === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                {t(s === 'memory' ? 'work.memoryAgents' : 'work.workerAgents')}
              </button>
            ))}
          </div>
          <button onClick={() => { loadRuns(); loadStatus() }} className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
          </button>
        </div>

        {/* Agent status bar */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 bg-white rounded-xl border border-slate-100 shadow-sm px-4 py-2.5 mb-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${status?.serve_reachable ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            <span className="font-medium text-slate-700">{status?.agent_provider || 'agent'} {status?.serve_reachable ? t('work.live') : t('work.offline')}</span>
          </span>
          <span className="text-slate-400">{t('work.runExec')} <span className={`font-semibold ${status?.web_allow_run ? 'text-emerald-600' : 'text-red-600'}`}>{status?.web_allow_run ? 'on' : 'off'}</span></span>
          {status?.now && <span className="text-[10px] text-slate-400 ml-auto">{String(status.now).replace('T', ' ').slice(0, 19)}</span>}
        </div>

        {/* Runs (filtered by sub-tab) + event log */}
        <div className="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-50 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              {sub === 'memory' ? t('work.memoryRuns') : t('work.workerRuns')}
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-1.5 space-y-0.5">
              {shown.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-6">{t('work.noRuns')}</p>
              ) : shown.map(r => (
                <button key={r.id} onClick={() => setSelRun(r.id)} className={`block w-full text-left rounded-lg px-2.5 py-2 transition-colors ${selRun === r.id ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-bold border ${statusColor(r.status)}`}>{r.status}</span>
                    <span className="text-[9px] uppercase tracking-wider text-slate-400">{r.kind}</span>
                    <span className="text-[10px] text-slate-400 ml-auto">
                      {r.created ? new Date(r.created).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                  <div className="text-xs text-slate-700 truncate mt-1">{r.summary || r.command || r.prompt || r.kind}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-50">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('work.events')}</span>
              {canAbort && (
                <button onClick={() => selRun && abortHypogumRun(selRun).then(loadRuns).catch(() => {})} className="text-[10px] font-semibold text-red-600 hover:text-red-800">{t('work.abort')}</button>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-3">
              {!selRun ? (
                <EmptyState icon={<RefreshCw className="w-6 h-6 text-slate-400" />} title={t('work.selectRun')} hint="" />
              ) : runEvents.length === 0 ? (
                <span className="text-[11px] text-slate-400">…</span>
              ) : runEvents.map((ev, i) => (
                <EventRow key={i} ev={ev} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
