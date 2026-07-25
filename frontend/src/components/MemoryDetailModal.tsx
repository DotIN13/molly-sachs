import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import Markdown from './Markdown'
import { fetchHypogumMemoryPage } from '../hypogum'

interface Props {
  path: string
  onClose: () => void
  onOpenPath: (p: string) => void
}

export default function MemoryDetailModal({ path, onClose, onOpenPath }: Props) {
  const { t } = useTranslation()
  const [page, setPage] = useState<any | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    setPage(null); setErr(false)
    fetchHypogumMemoryPage(path).then(setPage).catch(() => setErr(true))
  }, [path])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/20 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl border-l border-slate-100" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800 truncate">{page?.title || path}</div>
            <div className="text-[10px] font-mono text-slate-400 truncate">{path}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {err ? (
            <p className="text-xs text-slate-400">{t('memories.detailError')}</p>
          ) : !page ? (
            <p className="text-xs text-slate-400">…</p>
          ) : (
            <>
              {page.frontmatter && Object.keys(page.frontmatter).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(page.frontmatter).map(([k, v]) => (
                    <span key={k} className="text-[10px] bg-slate-100 text-slate-600 rounded px-1.5 py-0.5">
                      <span className="text-slate-400">{k}:</span> {String(v)}
                    </span>
                  ))}
                </div>
              )}
              <Markdown content={page.body || page.content || ''} />
              {page.wikilinks?.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">{t('memories.links')}</div>
                  <div className="flex flex-wrap gap-2">
                    {page.wikilinks.map((w: any, i: number) => w.path ? (
                      <button key={i} onClick={() => onOpenPath(w.path)} className="text-[11px] text-indigo-600 hover:underline">{w.name}</button>
                    ) : (
                      <span key={i} className="text-[11px] text-slate-400">{w.name}</span>
                    ))}
                  </div>
                </div>
              )}
              {page.backlinks?.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">{t('memories.backlinks')}</div>
                  <div className="flex flex-wrap gap-2">
                    {page.backlinks.map((b: any, i: number) => (
                      <button key={i} onClick={() => onOpenPath(b.path)} className="text-[11px] text-indigo-600 hover:underline">{b.title}</button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
