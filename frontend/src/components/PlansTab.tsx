import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Play, ListTodo } from 'lucide-react'
import EmptyState from './EmptyState'
import { fetchHypogumPlans, runHypogumPlanTask } from '../hypogum'

function statusColor(s: string): string {
  if (s === 'done') return 'bg-emerald-50 text-emerald-700 border-emerald-100'
  if (s === 'running' || s === 'queued') return 'bg-blue-50 text-blue-700 border-blue-100'
  if (['error', 'timeout', 'aborted'].includes(s)) return 'bg-red-50 text-red-700 border-red-100'
  return 'bg-slate-100 text-slate-600 border-slate-200'
}

export default function PlansTab() {
  const { t } = useTranslation()
  const [plans, setPlans] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState<string | null>(null)

  const loadPlans = async () => {
    setLoading(true)
    try { setPlans(await fetchHypogumPlans()) } catch { /* offline */ } finally { setLoading(false) }
  }

  useEffect(() => { loadPlans() }, [])

  const runTask = async (planPath: string, task: any) => {
    setRunning(task.path)
    try {
      await runHypogumPlanTask(planPath, task.prompt || '', task.path)
    } catch (e) {
      console.error('run task failed', e)
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
      <div className="max-w-3xl mx-auto w-full animate-in fade-in duration-300">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{t('tabs.plans')}</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">{t('plans.desc')}</p>
          </div>
          <button onClick={() => loadPlans()} className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
          </button>
        </div>

        {plans.length === 0 ? (
          <EmptyState icon={<ListTodo className="w-6 h-6 text-slate-400" />} title={t('plans.empty')} hint={t('plans.emptyHint')} />
        ) : (
          <div className="space-y-4">
            {plans.map(p => (
              <div key={p.path} className="bg-white rounded-2xl border border-slate-100 p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800">{p.title || p.plan_id}</span>
                  <span className="text-[10px] text-slate-400">{p.task_count} {t('plans.tasks')}</span>
                </div>
                {p.summary && <p className="text-[11px] text-slate-500 mt-1">{p.summary}</p>}
                <div className="mt-3 space-y-2">
                  {(p.items || []).map((task: any) => (
                    <div key={task.path} className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {task.group && <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-bold bg-slate-100 text-slate-500 border border-slate-200">{task.group}</span>}
                          {task.status && <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-bold border ${statusColor(task.status)}`}>{task.status}</span>}
                          <span className="text-xs font-medium text-slate-800 truncate">{task.title}</span>
                        </div>
                        {task.summary && <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{task.summary}</div>}
                      </div>
                      <button
                        onClick={() => runTask(p.path, task)}
                        disabled={running === task.path}
                        className="shrink-0 flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-1 rounded-lg hover:bg-emerald-100 disabled:opacity-50"
                      >
                        <Play className="w-3 h-3" /> {t('plans.run')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {loading && <p className="text-center text-[10px] text-slate-400 mt-4">…</p>}
      </div>
    </div>
  )
}
