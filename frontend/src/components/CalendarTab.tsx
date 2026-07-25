import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Clock, ChevronLeft, ChevronRight } from 'lucide-react'
import EmptyState from './EmptyState'
import CalendarEventDetail from './CalendarEventDetail'
import { fetchHypogumCalendar, acceptCalendarBlock, dismissCalendarBlock } from '../hypogum'

const bucketBadge = (bucket: string) =>
  bucket === 'suggested' ? 'bg-amber-50 text-amber-700 border-amber-100'
    : bucket === 'planned' ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
      : 'bg-slate-100 text-slate-600 border-slate-200'

const bucketBlock = (b: string) =>
  b === 'suggested' ? 'bg-amber-50 border-amber-200 text-amber-800'
    : b === 'planned' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : 'bg-slate-100 border-slate-300 text-slate-700'

const hhmm = (v?: string) => (v && String(v).length >= 16 ? String(v).slice(11, 16) : '')
const dayOf = (e: any) => e.date || (e.start ? String(e.start).slice(0, 10) : 'unknown')
const fmtLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Apple-style week time-grid geometry.
const HOUR_H = 44 // px per hour
const HOURS = Array.from({ length: 24 }, (_, h) => h)

// Minutes-since-midnight from an ISO string's HH:MM (as stored, no tz shift).
const tmin = (v?: string): number | null => {
  if (!v || String(v).length < 16) return null
  const s = String(v)
  const h = Number(s.slice(11, 13)), m = Number(s.slice(14, 16))
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
}

// Lay out a day's timed events into non-overlapping lanes (Apple-style
// side-by-side for concurrent events). Returns geometry per event.
function layoutDay(events: any[]): { e: any; s: number; en: number; lane: number; lanes: number }[] {
  const timed = events
    .map(e => {
      const s = tmin(e.start)
      if (s == null) return null
      let en = tmin(e.end)
      if (en == null || en <= s) en = s + 60
      return { e, s, en }
    })
    .filter(Boolean) as { e: any; s: number; en: number }[]
  timed.sort((a, b) => a.s - b.s || a.en - b.en)

  const out: { e: any; s: number; en: number; lane: number; lanes: number }[] = []
  let i = 0
  while (i < timed.length) {
    let clusterEnd = timed[i].en
    const cluster = [timed[i]]
    let j = i + 1
    while (j < timed.length && timed[j].s < clusterEnd) {
      cluster.push(timed[j]); clusterEnd = Math.max(clusterEnd, timed[j].en); j++
    }
    const laneEnds: number[] = []
    const laneOf = new Map<any, number>()
    for (const item of cluster) {
      let lane = laneEnds.findIndex(end => end <= item.s)
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(item.en) } else { laneEnds[lane] = item.en }
      laneOf.set(item, lane)
    }
    const lanes = laneEnds.length
    for (const item of cluster) out.push({ ...item, lane: laneOf.get(item)!, lanes })
    i = j
  }
  return out
}

export default function CalendarTab() {
  const { t, i18n } = useTranslation()
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'day' | 'week'>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [selected, setSelected] = useState<any | null>(null)

  const load = async () => {
    setLoading(true)
    try { setEntries(await fetchHypogumCalendar()) } catch { /* offline */ } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const act = async (action: 'accept' | 'dismiss', path: string) => {
    try {
      if (action === 'accept') await acceptCalendarBlock(path); else await dismissCalendarBlock(path)
      load()
    } catch (e) { console.error(`calendar ${action} failed`, e) }
  }

  const byDay = entries.reduce((acc: Record<string, any[]>, e: any) => {
    ;(acc[dayOf(e)] = acc[dayOf(e)] || []).push(e); return acc
  }, {})
  const sortByStart = (a: any, b: any) => String(a.start || '').localeCompare(String(b.start || ''))

  // Week (Mon–Sun) for the current offset.
  const base = new Date(); base.setDate(base.getDate() + weekOffset * 7)
  const dow = (base.getDay() + 6) % 7
  const monday = new Date(base); monday.setDate(base.getDate() - dow)
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i); return d
  })
  const todayIso = fmtLocal(new Date())
  const weekRange = `${fmtLocal(weekDays[0]).slice(5)} – ${fmtLocal(weekDays[6]).slice(5)}`

  const ActionBtns = ({ e }: { e: any }) => (e.bucket === 'suggested' && e.path) ? (
    <div className="flex gap-1 flex-shrink-0">
      <button onClick={(ev) => { ev.stopPropagation(); act('accept', e.path) }} className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-1 rounded-lg hover:bg-emerald-100">{t('calendar.accept')}</button>
      <button onClick={(ev) => { ev.stopPropagation(); act('dismiss', e.path) }} className="text-[10px] font-semibold text-slate-500 bg-slate-50 border border-slate-200 px-2 py-1 rounded-lg hover:bg-slate-100">{t('calendar.dismiss')}</button>
    </div>
  ) : null

  return (
    <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
      <div className="max-w-6xl mx-auto w-full animate-in fade-in duration-300">
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {/* Day / Week toggle */}
            <div className="flex bg-slate-100 rounded-lg p-0.5 border border-slate-200/60">
              {(['week', 'day'] as const).map(v => (
                <button key={v} onClick={() => setView(v)} className={`text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                  {t(`calendar.${v}`)}
                </button>
              ))}
            </div>
            {/* Week navigation (week view only) */}
            {view === 'week' && (
              <div className="flex items-center gap-1">
                <button onClick={() => setWeekOffset(weekOffset - 1)} className="p-1 rounded-lg text-slate-500 hover:bg-slate-100"><ChevronLeft className="w-4 h-4" /></button>
                <button onClick={() => setWeekOffset(0)} className="text-xs font-semibold text-slate-700 min-w-[96px] text-center hover:text-slate-900">
                  {weekOffset === 0 ? t('calendar.thisWeek') : weekRange}
                </button>
                <button onClick={() => setWeekOffset(weekOffset + 1)} className="p-1 rounded-lg text-slate-500 hover:bg-slate-100"><ChevronRight className="w-4 h-4" /></button>
              </div>
            )}
          </div>
          <button onClick={load} className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
          </button>
        </div>

        {entries.length === 0 ? (
          <EmptyState icon={<Clock className="w-6 h-6 text-slate-400" />} title={t('calendar.empty')} hint={t('calendar.emptyHint')} />
        ) : view === 'day' ? (
          /* ── Daily agenda: all days, newest first ── */
          <div className="space-y-6">
            {Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).map(([day, list]) => (
              <div key={day}>
                <h4 className="text-xs font-bold text-slate-700 mb-2">{day}</h4>
                <div className="space-y-2">
                  {(list as any[]).slice().sort(sortByStart).map((e: any, i: number) => (
                    <div key={i} onClick={() => setSelected(e)} className="bg-white rounded-xl border border-slate-100 p-3 shadow-sm flex items-start justify-between gap-3 cursor-pointer hover:shadow-md hover:border-slate-200 transition-all">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold border ${bucketBadge(e.bucket || 'observed')}`}>{t(`calendar.${e.bucket || 'observed'}`)}</span>
                          {hhmm(e.start) && <span className="text-[10px] font-mono text-slate-400">{hhmm(e.start)}{hhmm(e.end) ? `–${hhmm(e.end)}` : ''}</span>}
                          {e.category && <span className="text-[10px] text-slate-400">{e.category}</span>}
                        </div>
                        <p className="text-xs text-slate-800 font-medium mt-1 leading-snug">{e.title}</p>
                      </div>
                      <ActionBtns e={e} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* ── Weekly grid: Mon–Sun for the selected week ── */
          <div>
            <div className="border border-slate-200 rounded-xl bg-white overflow-auto max-h-[68vh]">
              <div className="min-w-[680px]">
                {/* Header: weekday + date, aligned to the columns */}
                <div className="flex sticky top-0 z-20 bg-white border-b border-slate-200">
                  <div className="w-12 shrink-0" />
                  {weekDays.map((d) => {
                    const isToday = fmtLocal(d) === todayIso
                    return (
                      <div key={fmtLocal(d)} className="flex-1 text-center py-1.5 border-l border-slate-100">
                        <div className="text-[9px] uppercase tracking-wider text-slate-400">{d.toLocaleDateString(i18n.language, { weekday: 'short' })}</div>
                        <div className={`text-sm font-bold mt-0.5 mx-auto w-6 h-6 flex items-center justify-center rounded-full ${isToday ? 'bg-slate-900 text-white' : 'text-slate-700'}`}>{d.getDate()}</div>
                      </div>
                    )
                  })}
                </div>

                {/* All-day row: events with no time */}
                {weekDays.some(d => (byDay[fmtLocal(d)] || []).some((e: any) => tmin(e.start) == null)) && (
                  <div className="flex border-b border-slate-200 bg-slate-50/40">
                    <div className="w-12 shrink-0 text-[8px] uppercase tracking-wider text-slate-400 flex items-center justify-end pr-1.5 py-1">{t('calendar.allDay')}</div>
                    {weekDays.map((d) => {
                      const allday = (byDay[fmtLocal(d)] || []).filter((e: any) => tmin(e.start) == null)
                      return (
                        <div key={fmtLocal(d)} className="flex-1 border-l border-slate-100 p-1 space-y-1">
                          {allday.map((e: any, i: number) => (
                            <div key={i} className={`text-[9px] leading-tight rounded px-1 py-0.5 border truncate ${bucketBlock(e.bucket || 'observed')}`} title={e.title}>{e.title}</div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Time grid */}
                <div className="flex relative">
                  {/* hour gutter */}
                  <div className="w-12 shrink-0">
                    {HOURS.map(h => (
                      <div key={h} style={{ height: HOUR_H }} className="relative">
                        <span className="absolute -top-1.5 right-1 text-[9px] text-slate-400 tabular-nums">{h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}</span>
                      </div>
                    ))}
                  </div>
                  {/* day columns */}
                  {weekDays.map((d) => {
                    const iso = fmtLocal(d)
                    const laid = layoutDay(byDay[iso] || [])
                    const isToday = iso === todayIso
                    const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
                    return (
                      <div key={iso} className="flex-1 relative border-l border-slate-100" style={{ height: 24 * HOUR_H }}>
                        {/* hour lines */}
                        {HOURS.map(h => (
                          <div key={h} style={{ top: h * HOUR_H }} className="absolute left-0 right-0 border-t border-slate-50" />
                        ))}
                        {/* now indicator */}
                        {isToday && (
                          <div style={{ top: (nowMin / 60) * HOUR_H }} className="absolute left-0 right-0 z-10 pointer-events-none">
                            <div className="h-px bg-red-500" />
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500 -mt-[3px] -ml-[3px]" />
                          </div>
                        )}
                        {/* events */}
                        {laid.map(({ e, s, en, lane, lanes }, i) => (
                          <div
                            key={i}
                            onClick={() => setSelected(e)}
                            title={`${hhmm(e.start)}${hhmm(e.end) ? `–${hhmm(e.end)}` : ''}  ${e.title}`}
                            style={{
                              top: (s / 60) * HOUR_H + 1,
                              height: Math.max(16, ((en - s) / 60) * HOUR_H - 2),
                              left: `calc(${(lane / lanes) * 100}% + 1px)`,
                              width: `calc(${100 / lanes}% - 2px)`,
                            }}
                            className={`absolute overflow-hidden rounded-md border px-1 py-0.5 shadow-sm cursor-pointer hover:brightness-95 ${bucketBlock(e.bucket || 'observed')}`}
                          >
                            <div className="text-[9px] font-medium leading-tight truncate">{e.title}</div>
                            {((en - s) >= 45) && <div className="text-[8px] opacity-70 leading-tight">{hhmm(e.start)}</div>}
                            {e.bucket === 'suggested' && e.path && (
                              <div className="flex gap-1.5 mt-0.5">
                                <button onClick={(ev) => { ev.stopPropagation(); act('accept', e.path) }} className="text-[9px] font-bold hover:underline">✓</button>
                                <button onClick={(ev) => { ev.stopPropagation(); act('dismiss', e.path) }} className="text-[9px] font-bold opacity-60 hover:underline">✕</button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
        {loading && <p className="text-center text-[10px] text-slate-400 mt-4">…</p>}
      </div>

      {selected && (
        <CalendarEventDetail event={selected} onClose={() => setSelected(null)} onChanged={load} />
      )}
    </div>
  )
}
