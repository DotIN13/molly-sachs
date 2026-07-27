import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Trash2, Loader2, Plus, Check, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { API_URL } from '../config'
import { useAuth } from '../contexts/AuthContext'

interface Voice { voice_id: string; status?: string; created?: string }

interface Props {
  /** Currently selected voice id. */
  value: string
  onChange: (voiceId: string) => void
  /** Clone target — a voice belongs to a model series. */
  model: string
  /** The v3.5 family has no system voices, so cloning is the only option. */
  requiresClone: boolean
  /** Lets a mismatch be resolved by moving the model to the voice. */
  onModelChange?: (model: string) => void
}

/** The model a cloned voice was enrolled for, read off its own id, which is
 *  `<target_model>-<prefix>-<32 hex>`. Mirrors model_for_voice() in
 *  backend/cosyvoice_tts.py — the trailing uuid is the only thing that makes
 *  the split unambiguous, since model and prefix are both lowercase
 *  alphanumeric runs. Null for a system voice name, which has no such binding. */
const CLONED_VOICE_RE = /^(cosyvoice-[a-z0-9.-]+?)-[a-z0-9]{1,9}-[0-9a-f]{32}$/
function modelForVoice(id: string): string | null {
  return CLONED_VOICE_RE.exec(id || '')?.[1] ?? null
}

/** A dialog stacked over the settings modal.
 *
 *  Deliberately not a portal: rendering inside the settings card means clicks
 *  in here never reach that card's backdrop, which closes *and saves* settings
 *  on any outside click. The z-index only has to clear the card's own z-50. */
function Popup({ title, z, onClose, children }: {
  title: string
  z: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className={`fixed inset-0 ${z} flex items-center justify-center p-4 bg-slate-900/20 backdrop-blur-sm animate-in fade-in`}
      onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 animate-in zoom-in-95 flex flex-col max-h-[70vh]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
          <h3 className="text-xs font-semibold text-slate-800">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

/** Selects a CosyVoice voice, and clones new ones, each in its own dialog.
 *
 *  Only voices belonging to the selected model are offered. A cloned voice is
 *  bound to the model it was enrolled against and is rejected by every other
 *  one — including a newer one — and the rejection arrives as an opaque
 *  "Engine return error code: 418" at synthesis time, long after the choice
 *  was made. Showing a voice that cannot speak is worse than hiding it. */
export default function CosyVoicePicker({ value, onChange, model, requiresClone, onModelChange }: Props) {
  const { t } = useTranslation()
  const auth = useAuth()

  const [voices, setVoices] = useState<Voice[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const [picking, setPicking] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [prefix, setPrefix] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [sampleUrl, setSampleUrl] = useState('')

  const err = (code: string) =>
    t(`settings.voiceError.${code}`, { defaultValue: t('settings.voiceError.upstream') })

  // Voices the selected model can actually speak with, and how many were held
  // back — a list that silently shrank would read as voices having gone missing.
  const usable = voices?.filter(v => modelForVoice(v.voice_id) === model) ?? null
  const hidden = (voices?.length ?? 0) - (usable?.length ?? 0)
  // The typed-id escape hatch can still land on a foreign voice, and a stored
  // one predates this filter existing.
  const selectedModel = modelForVoice(value)
  const mismatch = selectedModel !== null && selectedModel !== model ? selectedModel : null

  const load = async () => {
    setLoading(true); setError('')
    try {
      const res = await auth.authFetch(`${API_URL}/api/tts/cosyvoice/voices`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(typeof data?.detail === 'string' ? data.detail : 'upstream'); setVoices([]) }
      else setVoices(data.voices || [])
    } catch { setError('network'); setVoices([]) }
    finally { setLoading(false) }
  }

  // Opening a picker onto an empty list that only fills after a manual refresh
  // reads as "no voices". Fetch once, then leave it to the refresh button.
  useEffect(() => {
    if (picking && voices === null && !loading) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking])

  // Escape closes the topmost dialog only, so it never blows through both.
  useEffect(() => {
    if (!picking && !cloning) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (cloning) setCloning(false)
      else setPicking(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [picking, cloning])

  const clone = async () => {
    if (!prefix || (!file && !sampleUrl.trim())) return
    setBusy('clone'); setError('')
    const body = new FormData()
    body.append('prefix', prefix)
    body.append('target_model', model)
    if (file) body.append('sample', file)
    else body.append('url', sampleUrl.trim())
    try {
      const res = await auth.authFetch(`${API_URL}/api/tts/cosyvoice/voices`,
        { method: 'POST', body })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(typeof data?.detail === 'string' ? data.detail : 'upstream'); return }
      onChange(data.voice_id)            // select what was just created
      setCloning(false); setPrefix(''); setFile(null); setSampleUrl('')
      await load()
    } catch { setError('network') }
    finally { setBusy('') }
  }

  const remove = async (id: string) => {
    setBusy(id); setError('')
    try {
      const res = await auth.authFetch(`${API_URL}/api/tts/cosyvoice/voices/${encodeURIComponent(id)}`,
        { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(typeof data?.detail === 'string' ? data.detail : 'upstream')
        return
      }
      if (value === id) onChange('')
      await load()
    } catch { setError('network') }
    finally { setBusy('') }
  }

  const errorBox = error && (
    <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">{err(error)}</p>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-slate-700">{t('settings.cosyvoiceVoice')}</label>
        <button type="button" onClick={() => setPicking(true)}
          className="text-[11px] font-medium text-blue-700 hover:text-blue-900">
          {t('settings.voiceChoose')}
        </button>
      </div>

      <button type="button" onClick={() => setPicking(true)}
        className="rounded-md border border-slate-200 bg-[#f9f9f9] px-3 h-9 text-left text-sm hover:bg-slate-50">
        {value
          ? <span className="block truncate text-slate-700">{value}</span>
          : <span className="text-slate-400">
              {requiresClone ? t('settings.cosyvoiceVoiceIdPlaceholder') : 'longanyang'}
            </span>}
      </button>

      {/* Stays out here: a stored voice that cannot speak is a problem the user
          has to see in Settings, without opening anything first. */}
      {mismatch && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {t('settings.voiceMismatch', { model: mismatch })}
          {onModelChange && (
            <button type="button" onClick={() => onModelChange(mismatch)}
              className="ml-1 font-medium underline hover:text-amber-900">
              {t('settings.voiceUseItsModel', { model: mismatch })}
            </button>
          )}
        </p>
      )}

      {picking && (
        <Popup title={t('settings.voicePickerTitle')} z="z-[60]" onClose={() => setPicking(false)}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400">{model}</span>
            <button type="button" onClick={load} disabled={loading}
              className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-800 disabled:opacity-40">
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {t('settings.voiceRefresh')}
            </button>
          </div>

          {voices !== null && usable !== null && (
            usable.length === 0 ? (
              <p className="text-[10px] text-slate-400">
                {voices.length === 0
                  ? t('settings.voiceNone')
                  : t('settings.voiceNoneForModel', { model, count: hidden })}
              </p>
            ) : (
              <ul className="rounded-lg border border-slate-200 divide-y divide-slate-100">
                {usable.map(v => (
                  <li key={v.voice_id}
                    className={`flex items-center gap-2 px-2 py-1.5 text-[11px] ${value === v.voice_id ? 'bg-[#eef2fc]' : 'hover:bg-slate-50'}`}>
                    <button type="button" onClick={() => { onChange(v.voice_id); setPicking(false) }}
                      className="flex-1 min-w-0 text-left">
                      <span className="block truncate text-slate-700">{v.voice_id}</span>
                      {v.status && <span className="text-[9px] text-slate-400">{v.status}</span>}
                    </button>
                    {value === v.voice_id && <Check className="w-3 h-3 text-blue-600 flex-shrink-0" />}
                    <button type="button" onClick={() => remove(v.voice_id)} disabled={busy === v.voice_id}
                      title={t('settings.voiceDelete')}
                      className="text-slate-300 hover:text-rose-600 disabled:opacity-40 flex-shrink-0">
                      {busy === v.voice_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          {usable !== null && usable.length > 0 && hidden > 0 && (
            <p className="text-[10px] text-slate-400">{t('settings.voiceHiddenOther', { count: hidden })}</p>
          )}

          {/* Typing an id stays possible: a voice made in the Model Studio
              console is perfectly valid and need not appear in this list. */}
          <label className="text-[10px] text-slate-500 mt-1">{t('settings.voiceCustomId')}</label>
          <Input value={value} onChange={e => onChange(e.target.value)}
            className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300"
            placeholder={requiresClone ? t('settings.cosyvoiceVoiceIdPlaceholder') : 'longanyang'} />

          {errorBox}

          <div className="flex items-center justify-between pt-1">
            <button type="button" onClick={() => { setError(''); setCloning(true) }}
              className="flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900">
              <Plus className="w-3 h-3" /> {t('settings.voiceClone')}
            </button>
            <button type="button" onClick={() => setPicking(false)}
              className="rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white">
              {t('settings.voiceDone')}
            </button>
          </div>
        </Popup>
      )}

      {cloning && (
        <Popup title={t('settings.voiceClone')} z="z-[70]" onClose={() => setCloning(false)}>
          <p className="text-[10px] text-slate-500">{t('settings.voiceCloneHint')}</p>
          {/* Named up front, because this binding is exactly what the voice can
              never be used outside of afterwards. */}
          <p className="text-[10px] text-slate-400">{t('settings.voiceCloneTarget', { model })}</p>
          <Input value={prefix} onChange={e => setPrefix(e.target.value.toLowerCase())}
            className="bg-white border-slate-200 text-sm" placeholder={t('settings.voicePrefix')} />
          <span className="text-[10px] text-slate-400">{t('settings.voicePrefixHint')}</span>
          <input type="file" accept=".wav,.mp3,.m4a,audio/*"
            onChange={e => { setFile(e.target.files?.[0] || null); setSampleUrl('') }}
            className="text-[11px] file:mr-2 file:rounded file:border-0 file:bg-slate-200 file:px-2 file:py-1 file:text-[11px]" />
          <Input value={sampleUrl} onChange={e => { setSampleUrl(e.target.value); setFile(null) }}
            className="bg-white border-slate-200 text-sm" placeholder={t('settings.voiceSampleUrl')} />

          {errorBox}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={clone} disabled={busy === 'clone' || !prefix || (!file && !sampleUrl.trim())}
              className="flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40">
              {busy === 'clone' && <Loader2 className="w-3 h-3 animate-spin" />}
              {t('settings.voiceCloneSubmit')}
            </button>
            <button type="button" onClick={() => { setCloning(false); setError('') }}
              className="text-[11px] text-slate-500 hover:text-slate-800">{t('settings.voiceCancel')}</button>
          </div>
        </Popup>
      )}

      {/* Errors raised outside a dialog (a delete from a previous session's
          list, say) still need somewhere to land. */}
      {!picking && !cloning && errorBox}
    </div>
  )
}
