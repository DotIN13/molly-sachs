import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Clock } from 'lucide-react'
import EmptyState from './EmptyState'
import ObservationCard from './ObservationCard'
import { fetchHypogumObservations } from '../hypogum'

const LIMIT = 15

export default function ObserversTab() {
  const { t } = useTranslation()
  const [source, setSource] = useState<'screen' | 'camera'>('screen')
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [lastRefresh, setLastRefresh] = useState(0)
  const offsetRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const load = async (append = false, force = false) => {
    if (append) setLoadingMore(true)
    else { setLoading(true); offsetRef.current = 0; setHasMore(true) }
    try {
      const offset = append ? offsetRef.current : 0
      const data = await fetchHypogumObservations(source, LIMIT, offset)
      setItems(prev => (append ? [...prev, ...data.items] : data.items))
      const next = offset + data.items.length
      offsetRef.current = next
      setHasMore(next < data.total)
      if (force) setLastRefresh(Date.now())
    } catch (e) {
      console.error('observations load failed', e)
    } finally {
      setLoading(false); setLoadingMore(false)
    }
  }

  // (Re)load when the source (screen/camera) changes.
  useEffect(() => { load(false) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [source])

  // Infinite scroll.
  useEffect(() => {
    const s = sentinelRef.current
    if (!s || !hasMore || loadingMore) return
    const obs = new IntersectionObserver(([en]) => { if (en.isIntersecting) load(true) }, { rootMargin: '200px' })
    obs.observe(s)
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loadingMore, items])

  const label = source === 'screen'
    ? { source: t('screen.source'), alt: t('screen.alt'), empty: t('screen.empty'), hint: t('screen.emptyHint') }
    : { source: t('camera.label'), alt: t('camera.alt'), empty: t('camera.empty'), hint: t('camera.emptyHint') }

  return (
    <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
      <div className="max-w-6xl mx-auto w-full animate-in fade-in duration-300">
        <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
          {/* Screen / Camera toggle */}
          <div className="flex bg-slate-100 rounded-lg p-0.5 border border-slate-200/60">
            {(['screen', 'camera'] as const).map(s => (
              <button key={s} onClick={() => setSource(s)} className={`text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${source === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                {t(`tabs.${s}`)}
              </button>
            ))}
          </div>
          <button onClick={() => load(false, true)} className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
          </button>
        </div>

        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-12"><RefreshCw className="w-5 h-5 text-slate-400 animate-spin" /></div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Clock className="w-6 h-6 text-slate-400" />} title={label.empty} hint={label.hint} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {items.map(cap => (
              <ObservationCard
                key={cap.id}
                id={cap.id}
                imageUrl={cap.imageUrl}
                timestamp={cap.timestamp}
                processed={true}
                sourceLabel={label.source}
                altText={label.alt}
                lastRefresh={lastRefresh}
              />
            ))}
            <div ref={sentinelRef} className="h-1" />
          </div>
        )}
        {loadingMore && <p className="text-center text-[10px] text-slate-400 mt-4">…</p>}
      </div>
    </div>
  )
}
