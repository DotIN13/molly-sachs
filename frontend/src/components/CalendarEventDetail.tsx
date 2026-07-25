import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Clock, Play, Check, Loader2, Sparkles } from 'lucide-react'
import Markdown from './Markdown'
import { runHypogumPlanTask, submitHypogumRun, acceptCalendarBlock, dismissCalendarBlock } from '../hypogum'

const bucketBadge = (bucket: string) =>
  bucket === 'suggested' ? 'bg-amber-50 text-amber-700 border-amber-100'
    : bucket === 'planned' ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
      : 'bg-slate-100 text-slate-600 border-slate-200'

const hhmm = (v?: string) => (v && String(v).length >= 16 ? String(v).slice(11, 16) : '')

interface Props {
  event: any
  onClose: () => void
  onChanged: () => void   // reload calendar after accept/dismiss
}

export default function CalendarEventDetail({ event: e, onClose, onChanged }: Props) {
  const { t } = useTranslation()
  // Track which task path is launching, and the id/label of the last queued run.
  const [running, setRunning] = useState<string | null>(null)
  const [queued, setQueued] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  const [acting, setActing] = useState(false)

  const linked: any[] = Array.isArray(e.linked_tasks) ? e.linked_tasks : []
  const timeStr = hhmm(e.start) ? `${hhmm(e.start)}${hhmm(e.end) ? `–${hhmm(e.end)}` : ''}` : t('calendar.allDay')

  const runLinked = async (task: any) => {
    setRunning(task.path); setErr(false); setQueued(null)
    try {
      const planPath = task.plan_id ? `agent_plan/${task.plan_id}` : (task.path || '')
      const run = await runHypogumPlanTask(planPath, task.prompt || '', task.path)
      setQueued(run?.id || task.title || task.path)
    } catch { setErr(true) } finally { setRunning(null) }
  }

  const runAdhoc = async () => {
    setRunning('__adhoc__'); setErr(false); setQueued(null)
    const prompt = [e.title, e.body].filter(Boolean).join('\n\n').trim()
    try {
      const run = await submitHypogumRun(prompt)
      setQueued(run?.id || e.title)
    } catch { setErr(true) } finally { setRunning(null) }
  }

  const act = async (action: 'accept' | 'dismiss') => {
    if (!e.path) return
    setActing(true)
    try {
      if (action === 'accept') await acceptCalendarBlock(e.path); else await dismissCalendarBlock(e.path)
      onChanged(); onClose()
    } catch { setErr(true) } finally { setActing(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/20 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-full w-full max-w-lg flex-col bg-white shadow-2xl border-l border-slate-100 animate-in slide-in-from-right duration-200" onClick={ev => ev.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold border ${bucketBadge(e.bucket || 'observed')}`}>{t(`calendar.${e.bucket || 'observed'}`)}</span>
              {e.category && <span className="text-[10px] text-slate-400">{e.category}</span>}
            </div>
            <h3 className="text-sm font-bold text-slate-800 leading-snug">{e.title}</h3>
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-500">
              <Clock className="w-3 h-3" />
              <span>{e.date || (e.start ? String(e.start).slice(0, 10) : '')}</span>
              <span className="text-slate-300">·</span>
              <span className="font-mono">{timeStr}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 flex-shrink-0"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Body */}
          {e.body && String(e.body).trim() && (
            <div className="text-sm text-slate-700 leading-relaxed">
              <Markdown content={e.body} />
            </div>
          )}

          {/* Accept / dismiss for suggested blocks */}
          {e.bucket === 'suggested' && e.path && (
            <div className="flex gap-2">
              <button onClick={() => act('accept')} disabled={acting} className="flex-1 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-3 py-2 rounded-lg hover:bg-emerald-100 disabled:opacity-50">{t('calendar.accept')}</button>
              <button onClick={() => act('dismiss')} disabled={acting} className="flex-1 text-xs font-semibold text-slate-500 bg-slate-50 border border-slate-200 px-3 py-2 rounded-lg hover:bg-slate-100 disabled:opacity-50">{t('calendar.dismiss')}</button>
            </div>
          )}

          {/* Linked agent tasks */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">{t('calendar.linkedTasks')}</div>
            {linked.length === 0 ? (
              <p className="text-[11px] text-slate-400 mb-3">{t('calendar.noLinkedTasks')}</p>
            ) : (
              <div className="space-y-2 mb-3">
                {linked.map((task: any, i: number) => (
                  <div key={i} className="flex items-start justify-between gap-2 bg-slate-50/70 border border-slate-100 rounded-lg p-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-800 truncate">{task.title || task.task_id || task.path}</p>
                      {task.summary && <p className="text-[10px] text-slate-500 mt-0.5 line-clamp-2">{task.summary}</p>}
                      {task.status && <span className="text-[9px] text-slate-400">{task.status}</span>}
                    </div>
                    <button
                      onClick={() => runLinked(task)}
                      disabled={running === task.path}
                      className="flex items-center gap-1 text-[10px] font-semibold text-slate-600 bg-white border border-slate-200 px-2.5 py-1.5 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex-shrink-0"
                    >
                      {running === task.path ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                      {t('calendar.runTask')}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Freeform: run an agent seeded from this event */}
            <button
              onClick={runAdhoc}
              disabled={running === '__adhoc__'}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-100 px-3 py-2 rounded-lg hover:bg-indigo-100 disabled:opacity-50"
            >
              {running === '__adhoc__' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {t('calendar.runAgent')}
            </button>
          </div>

          {/* Feedback */}
          {queued && (
            <div className="flex items-center gap-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
              <Check className="w-3.5 h-3.5" /> {t('calendar.runQueued')}
            </div>
          )}
          {err && (
            <div className="text-[11px] text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{t('calendar.runError')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
