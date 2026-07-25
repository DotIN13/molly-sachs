import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Pencil, RefreshCw } from 'lucide-react'
import Markdown from './Markdown'
import { fetchHypogumMemoryPage, saveHypogumMemoryPage } from '../hypogum'

interface Props {
  path: string
  onClose: () => void
}

export default function MemoryDetailView({ path, onClose }: Props) {
  const { t } = useTranslation()
  const [page, setPage] = useState<any | null>(null)
  const [err, setErr] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(false)

  const load = () => {
    setPage(null); setErr(false); setEditing(false)
    fetchHypogumMemoryPage(path).then(setPage).catch(() => setErr(true))
  }

  useEffect(load, [path])

  const startEdit = () => {
    setDraft(page?.content ?? '')
    setSaveErr(false)
    setEditing(true)
  }

  const save = async () => {
    setSaving(true); setSaveErr(false)
    try {
      await saveHypogumMemoryPage(path, draft)
      const fresh = await fetchHypogumMemoryPage(path)
      setPage(fresh)
      setEditing(false)
    } catch {
      setSaveErr(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overflow-y-auto flex-1 min-h-0 bg-slate-50/40">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-slate-50/60 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-3xl mx-auto px-3 sm:px-6 md:px-10 py-3 flex items-center gap-3">
          <button onClick={onClose} title={t('memories.back')} className="text-slate-400 hover:text-slate-700 flex-shrink-0">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-800 truncate">{page?.title || path}</div>
            <div className="text-[10px] font-mono text-slate-400 truncate">{path}</div>
          </div>
          {!editing ? (
            <button
              onClick={startEdit}
              disabled={!page}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-600 border border-slate-200 bg-white px-3 py-1.5 rounded-lg shadow-sm hover:bg-slate-50 disabled:opacity-40 transition-colors flex-shrink-0"
            >
              <Pencil className="w-3.5 h-3.5" /> {t('memories.edit')}
            </button>
          ) : (
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setEditing(false)}
                className="text-xs text-slate-500 hover:text-slate-800 px-3 py-1.5 rounded-lg transition-colors"
              >
                {t('memories.cancel')}
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="text-xs font-semibold bg-slate-900 text-white px-4 py-1.5 rounded-lg hover:bg-slate-800 disabled:opacity-40 transition-all"
              >
                {saving ? t('memories.saving') : t('memories.save')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-3 sm:px-6 md:px-10 py-5 space-y-4">
        {err ? (
          <p className="text-xs text-slate-400">{t('memories.detailError')}</p>
        ) : !page ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-5 h-5 text-slate-400 animate-spin" />
          </div>
        ) : editing ? (
          <>
            {saveErr && <p className="text-xs text-rose-500">{t('memories.saveError')}</p>}
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              spellCheck={false}
              className="w-full min-h-[60vh] px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-mono leading-relaxed text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300/50 resize-y"
            />
          </>
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
          </>
        )}
      </div>
    </div>
  )
}
