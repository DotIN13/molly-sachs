import { useState, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, RefreshCw, Check, ChevronDown, AlertCircle } from 'lucide-react'
import { API_URL } from '../config'
import { useAuth } from '../contexts/AuthContext'

export interface ModelInfo {
  id: string
  label: string
  description?: string
  chat: boolean
}

interface Props {
  provider: string
  /** Current model id. Empty string means "use the provider default". */
  value: string
  /** The provider's default model id, shown when `value` is empty. */
  defaultModel: string
  onChange: (modelId: string) => void
}

/** Model id + provider default, in a searchable popup fed by the provider's
 *  own /models endpoint (proxied through Molly's backend so the key stays
 *  server-side). Any id can still be typed by hand — the list is a
 *  convenience, not a whitelist. */
export default function ModelPicker({ provider, value, defaultModel, onChange }: Props) {
  const { t } = useTranslation()
  const auth = useAuth()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [cursor, setCursor] = useState(0)
  // Provider whose catalogue `models` currently holds, so switching provider
  // refetches instead of showing the previous provider's models.
  const [loadedFor, setLoadedFor] = useState('')

  const listRef = useRef<HTMLDivElement>(null)

  const load = async (refresh: boolean) => {
    setLoading(true)
    setError('')
    setCursor(0)
    try {
      const res = await auth.authFetch(
        `${API_URL}/api/llm/models?provider=${encodeURIComponent(provider)}${refresh ? '&refresh=true' : ''}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data?.detail === 'string' ? data.detail : 'upstream_error')
        setModels([])
      } else {
        setModels(Array.isArray(data.models) ? data.models : [])
        setLoadedFor(provider)
      }
    } catch {
      setError('network_error')
      setModels([])
    } finally {
      setLoading(false)
    }
  }

  // Fetching happens on open rather than in an effect: the provider can only
  // change while the popup is closed (its <select> sits behind this overlay),
  // so opening is the one moment the catalogue can be stale.
  const openPicker = () => {
    setOpen(true)
    setQuery('')
    setShowAll(false)
    setCursor(0)
    if (loadedFor !== provider && !loading) load(false)
  }

  const hiddenCount = useMemo(
    () => models.filter(m => !m.chat).length, [models])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models
      .filter(m => showAll || m.chat)
      .filter(m => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
  }, [models, query, showAll])

  // Rows are [default, ...filtered] (+ a custom row when the query matches
  // nothing), so index 0 is always "provider default".
  const exactHit = filtered.some(m => m.id === query.trim())
  const customId = query.trim() && !exactHit ? query.trim() : ''
  const rowCount = 1 + filtered.length + (customId ? 1 : 0)

  const pick = (id: string) => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  const pickIndex = (i: number) => {
    if (i === 0) return pick('')
    if (customId && i === rowCount - 1) return pick(customId)
    const m = filtered[i - 1]
    if (m) pick(m.id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown'
        ? (cursor + 1) % rowCount
        : (cursor - 1 + rowCount) % rowCount
      setCursor(next)
      listRef.current?.querySelector(`[data-row="${next}"]`)
        ?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (e.key === 'Enter') { e.preventDefault(); pickIndex(cursor) }
  }

  const rowCls = (i: number) =>
    `w-full text-left px-4 py-2 transition-colors flex items-center gap-2 ${
      i === cursor ? 'bg-[#eef2fc]' : 'hover:bg-slate-50'}`

  return (
    <>
      <button
        type="button"
        onClick={openPicker}
        className="w-full h-9 px-3 flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-[#f9f9f9] text-sm text-left hover:border-slate-300 transition-colors"
      >
        <span className={`truncate ${value ? 'text-slate-800' : 'text-slate-400'}`}>
          {value || `${defaultModel} · ${t('settings.modelDefaultTag')}`}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4 bg-slate-900/10 backdrop-blur-sm animate-in fade-in"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 overflow-hidden animate-in zoom-in-95"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 px-4 border-b border-slate-100">
              <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={e => { setQuery(e.target.value); setCursor(0) }}
                onKeyDown={onKeyDown}
                placeholder={t('settings.modelSearchPlaceholder')}
                className="flex-1 py-3.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none bg-transparent"
              />
              <button
                type="button"
                onClick={() => load(true)}
                disabled={loading}
                title={t('settings.modelRefresh')}
                className="text-slate-400 hover:text-slate-700 transition-colors disabled:opacity-40 flex-shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <kbd className="text-[10px] text-slate-400 border border-slate-200 rounded px-1.5 py-0.5 flex-shrink-0">ESC</kbd>
            </div>

            {error && (
              <div className="flex items-start gap-2 px-4 py-3 bg-amber-50 border-b border-amber-100">
                <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-800 leading-relaxed">
                  {t(`settings.modelError.${error}`, { defaultValue: t('settings.modelError.upstream_error') })}
                </p>
              </div>
            )}

            <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1.5">
              <button type="button" data-row={0} onClick={() => pick('')}
                onMouseEnter={() => setCursor(0)} className={rowCls(0)}>
                <span className="flex-1 min-w-0">
                  <span className="text-sm text-slate-700">{t('settings.modelUseDefault')}</span>
                  <span className="block text-[10px] text-slate-400 truncate">{defaultModel}</span>
                </span>
                {!value && <Check className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />}
              </button>

              {loading && models.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-slate-400">{t('settings.modelLoading')}</p>
              )}
              {!loading && !error && filtered.length === 0 && !customId && (
                <p className="px-4 py-6 text-center text-xs text-slate-400">{t('settings.modelEmpty')}</p>
              )}

              {filtered.map((m, i) => (
                <button key={m.id} type="button" data-row={i + 1} onClick={() => pick(m.id)}
                  onMouseEnter={() => setCursor(i + 1)} className={rowCls(i + 1)}
                  title={m.description || m.id}>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-slate-700 truncate">{m.id}</span>
                    {m.label !== m.id && (
                      <span className="block text-[10px] text-slate-400 truncate">{m.label}</span>
                    )}
                  </span>
                  {!m.chat && (
                    <span className="text-[9px] uppercase tracking-wide text-slate-400 border border-slate-200 rounded px-1 py-0.5 flex-shrink-0">
                      {t('settings.modelNonChat')}
                    </span>
                  )}
                  {value === m.id && <Check className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />}
                </button>
              ))}

              {customId && (
                <button type="button" data-row={rowCount - 1} onClick={() => pick(customId)}
                  onMouseEnter={() => setCursor(rowCount - 1)} className={rowCls(rowCount - 1)}>
                  <span className="flex-1 min-w-0 text-sm text-slate-700 truncate">
                    {t('settings.modelUseCustom', { id: customId })}
                  </span>
                </button>
              )}
            </div>

            <div className="flex items-center justify-between px-4 py-2 border-t border-slate-100 bg-slate-50">
              <span className="text-[10px] text-slate-400">
                {t('settings.modelCount', { count: filtered.length })}
              </span>
              {hiddenCount > 0 && (
                <label className="flex items-center gap-1.5 text-[10px] text-slate-500 cursor-pointer select-none">
                  <input type="checkbox" checked={showAll}
                    onChange={e => { setShowAll(e.target.checked); setCursor(0) }}
                    className="w-3 h-3 accent-blue-600" />
                  {t('settings.modelShowAll', { count: hiddenCount })}
                </label>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
