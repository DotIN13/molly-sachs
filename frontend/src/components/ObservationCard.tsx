import { Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ObservationCardProps {
  id: string | number
  imageUrl: string
  timestamp: string
  processed: boolean
  sourceLabel: string
  altText: string
  lastRefresh: number
}

export default function ObservationCard({
  id,
  imageUrl,
  timestamp,
  processed,
  sourceLabel,
  altText,
  lastRefresh,
}: ObservationCardProps) {
  const { t } = useTranslation()
  const shortId = typeof id === 'string' ? id.split('/').pop() : id
  return (
    <div className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm bg-white hover:shadow-md transition-all hover:scale-[1.01] duration-300 group">
      <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
        <img
          src={`${imageUrl}&t=${lastRefresh}`}
          alt={altText}
          loading="lazy"
          className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-500"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
          <span className="text-[10px] font-mono text-white/90 truncate">{shortId}</span>
        </div>
      </div>
      <div className="p-4 bg-white">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">{sourceLabel}</span>
          <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${
            processed
              ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
              : 'bg-amber-50 text-amber-600 border border-amber-100'
          }`}>
            {processed ? t('status.processed') : t('status.pending')}
          </span>
        </div>
        <p className="text-[10px] text-slate-500 mt-2 font-mono flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded">
          <Clock className="w-3 h-3 text-slate-400" />
          {new Date(timestamp).toLocaleString()}
        </p>
      </div>
    </div>
  )
}
