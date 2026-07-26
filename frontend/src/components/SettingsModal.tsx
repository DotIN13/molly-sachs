import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import ModelPicker from './ModelPicker'
import { fetchHypogumSettings, patchHypogumSettings, hypogumHealthy, setHypogumUrl } from '../hypogum'

const TIMEZONES: { value: string; label: string }[] = (() => {
  const tzs: string[] = (() => {
    try { return (Intl as any).supportedValuesOf?.('timeZone') as string[] || [] }
    catch { return [] }
  })()
  const now = new Date()
  return tzs.map(tz => {
    try {
      const parts = Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(now)
      const offset = parts.find(p => p.type === 'timeZoneName')?.value.replace('GMT', 'UTC') || ''
      return { value: tz, label: `${tz} (${offset})` }
    } catch {
      return { value: tz, label: tz }
    }
  })
})()

const VOICE_PRESETS = [
  { id: '6eb8965c-e295-47bd-a9e4-3eeebb3abcff', name: 'Jing - Clear Coordinator', langKey: 'voiceLang.cn' },
  { id: '78386a09-04ef-484d-9b9d-efd13087b792', name: 'Lee - Adorable Friend', langKey: 'voiceLang.cn' },
  { id: '9cccd5d0-c6ad-4121-9ec9-5937a0487c09', name: 'Zheng - Chinese', langKey: 'voiceLang.cn' },
  { id: 'ef191366-f52f-447a-a398-ed8c0f2943a1', name: 'Archie - Approachable Mate', langKey: 'voiceLang.enGB' },
  { id: '62ae83ad-4f6a-430b-af41-a9bede9286ca', name: 'Gemma - Decisive Agent', langKey: 'voiceLang.enGB' },
  { id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02', name: 'Katie - Friendly Fixer', langKey: 'voiceLang.enUS' },
  { id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', name: 'Skylar - Friendly Guide', langKey: 'voiceLang.enUS' },
]

const TTS_LANGUAGES = [
  { code: 'en', key: 'languages.en' }, { code: 'zh', key: 'languages.zh' }, { code: 'ja', key: 'languages.ja' },
  { code: 'es', key: 'languages.es' }, { code: 'fr', key: 'languages.fr' }, { code: 'de', key: 'languages.de' },
  { code: 'pt', key: 'languages.pt' }, { code: 'it', key: 'languages.it' },
]

// v3.5 is Beijing-only and carries no system voices — the voice must be a
// cloned or designed id. v3 keeps system voices such as longanyang.
const COSYVOICE_MODELS = [
  'cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus',
  'cosyvoice-v3-flash', 'cosyvoice-v3-plus', 'cosyvoice-v2',
]
const COSYVOICE_BEIJING_WS = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
const needsClonedVoice = (m: string) => m.startsWith('cosyvoice-v3.5')

const EMOTIONS = ['calm', 'happy', 'excited', 'enthusiastic', 'curious', 'content', 'peaceful', 'serene', 'grateful', 'affectionate', 'flirtatious', 'sarcastic', 'sad', 'wistful', 'apologetic', 'confident', 'neutral']

export interface SettingsData {
  geminiKey: string
  cartesiaKey: string
  sonioxKey: string
  geminiKeyConfigured: boolean
  cartesiaKeyConfigured: boolean
  sonioxKeyConfigured: boolean
  llmProvider: string
  llmModel: string
  openaiKey: string
  anthropicKey: string
  deepseekKey: string
  openaiKeyConfigured: boolean
  anthropicKeyConfigured: boolean
  deepseekKeyConfigured: boolean
  ttsVoice: string
  ttsVolume: number
  ttsSpeed: number
  ttsEmotion: string
  sttLanguage: string
  sttProvider: string
  ttsLanguage: string
  ttsProvider: string
  dashscopeKey: string
  dashscopeKeyConfigured: boolean
  cosyvoiceModel: string
  cosyvoiceVoice: string
  cosyvoiceBaseUrl: string
  observerScreenActive: boolean
  observerCameraActive: boolean
  observerScreenInterval: number
  observerCameraInterval: number
  observerCaptureInterval: number
  observerProcessInterval: number
  settingsTab: string
  debugMode: boolean
  timezone: string
  hypogumBaseUrl: string
  /** Backend's report on the stored API keys: "ok" | "unreadable" | "no_cipher". */
  secretsStatus: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: () => Promise<void>
  settings: SettingsData
  onChange: (key: keyof SettingsData, value: any) => void
}

export default function SettingsModal({ isOpen, onClose, onSave, settings, onChange }: Props) {
  const { t, i18n } = useTranslation()
  const [customVoiceId, setCustomVoiceId] = useState('')

  // Hypogum persisted settings (the memory/autonomy brain). Loaded lazily when
  // the Hypogum section is opened; saved back to hypogum, not Molly. Empty
  // values fall back to hypogum's .env defaults.
  const [hg, setHg] = useState<Record<string, string>>({})
  const [hgLoaded, setHgLoaded] = useState(false)
  const [hgStatus, setHgStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [hgUrlStatus, setHgUrlStatus] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle')

  // Health-check the URL and, only if reachable, apply it + load hypogum's
  // settings. The knobs render only when connected (hgUrlStatus === 'ok').
  const refreshHypogum = async (url: string) => {
    setHgUrlStatus('checking')
    const ok = await hypogumHealthy(url)
    setHgUrlStatus(ok ? 'ok' : 'bad')
    if (!ok) return
    setHypogumUrl(url)
    try {
      const s = await fetchHypogumSettings()
      const str: Record<string, string> = {}
      for (const k of Object.keys(s)) str[k] = s[k] == null ? '' : String(s[k])
      setHg(str)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (isOpen && settings.settingsTab === 'hypogum' && !hgLoaded) {
      setHgLoaded(true)
      refreshHypogum(settings.hypogumBaseUrl || 'http://localhost:8056')
    }
    if (!isOpen) { setHgLoaded(false); setHgUrlStatus('idle') }
    // refreshHypogum reads the URL directly; safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, settings.settingsTab, hgLoaded])

  const hgSet = (k: string, v: string) => setHg(prev => ({ ...prev, [k]: v }))
  const saveHg = async () => {
    setHgStatus('saving')
    try {
      await patchHypogumSettings(hg)
      setHgStatus('saved')
      setTimeout(() => setHgStatus('idle'), 2000)
    } catch {
      setHgStatus('error')
    }
  }

  // LLM provider → its API-key field + placeholders (chat model selection).
  const LLM_KEY_FIELDS: Record<string, { label: string; field: keyof SettingsData; configured: keyof SettingsData; placeholder: string }> = {
    google: { label: 'settings.geminiApiKey', field: 'geminiKey', configured: 'geminiKeyConfigured', placeholder: 'settings.placeholderGemini' },
    openai: { label: 'settings.openaiApiKey', field: 'openaiKey', configured: 'openaiKeyConfigured', placeholder: 'settings.placeholderOpenai' },
    anthropic: { label: 'settings.anthropicApiKey', field: 'anthropicKey', configured: 'anthropicKeyConfigured', placeholder: 'settings.placeholderAnthropic' },
    deepseek: { label: 'settings.deepseekApiKey', field: 'deepseekKey', configured: 'deepseekKeyConfigured', placeholder: 'settings.placeholderDeepseek' },
  }
  const LLM_MODEL_PLACEHOLDER: Record<string, string> = {
    google: 'gemini-3.1-flash-lite', openai: 'gpt-4.1', anthropic: 'claude-sonnet-4-6', deepseek: 'deepseek-chat',
  }
  const llmKey = LLM_KEY_FIELDS[settings.llmProvider] || LLM_KEY_FIELDS.google

  if (!isOpen) return null

  const handleClose = () => {
    onSave()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/10 backdrop-blur-sm animate-in fade-in" onClick={handleClose}>
      <div className="w-full max-w-2xl bg-white rounded-xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 animate-in zoom-in-95 flex flex-col h-[480px] max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="flex flex-1 overflow-hidden flex-col lg:flex-row">
          <div className="flex-shrink-0 bg-slate-50 border-b border-slate-100 lg:border-b-0 lg:border-r lg:w-48 px-3 py-2 lg:py-8 flex flex-row lg:flex-col gap-1 overflow-x-auto lg:overflow-y-auto">
            <button onClick={() => onChange('settingsTab', 'general')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${settings.settingsTab === 'general' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>{t('settings.general')}</button>
            <button onClick={() => onChange('settingsTab', 'speech')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${settings.settingsTab === 'speech' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>{t('settings.speech')}</button>
            <button onClick={() => onChange('settingsTab', 'api')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${settings.settingsTab === 'api' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>{t('settings.apiConfig')}</button>
            <button onClick={() => onChange('settingsTab', 'hypogum')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${settings.settingsTab === 'hypogum' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>{t('settings.hypogum')}</button>
          </div>

          <div className="flex-1 px-4 sm:px-6 py-4 sm:py-10 overflow-y-auto">
            {settings.settingsTab === 'general' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.language')}</label>
                  <select
                    value={i18n.language}
                    onChange={e => i18n.changeLanguage(e.target.value)}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none"
                  >
                    <option value="en">English (United States)</option>
                    <option value="zh">简体中文（中国大陆）</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.timezone')}</label>
                  <select
                    value={settings.timezone || '__auto__'}
                    onChange={e => onChange('timezone', e.target.value === '__auto__' ? '' : e.target.value)}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none"
                  >
                    <option value="__auto__">{t('settings.timezoneAuto')}</option>
                    {TIMEZONES.map(tz => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            {settings.settingsTab === 'api' && (
              <div className="flex flex-col gap-4">
                {/* Stored keys exist but the backend cannot decrypt them — without
                    this the whole tab just reads as "nothing configured". */}
                {settings.secretsStatus && settings.secretsStatus !== 'ok' && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-md bg-amber-50 border border-amber-200">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-800 leading-relaxed">
                      {t(`settings.secretsStatus.${settings.secretsStatus}`, {
                        defaultValue: t('settings.secretsStatus.unreadable'),
                      })}
                    </p>
                  </div>
                )}
                {/* Chat LLM: provider + model + provider-specific key */}
                <div className="pb-1 border-b border-slate-100">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{t('settings.llmSection')}</h4>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.llmProvider')}</label>
                  <select
                    value={settings.llmProvider}
                    // A model id is provider-specific, so switching providers
                    // clears it back to that provider's default.
                    onChange={e => { onChange('llmProvider', e.target.value); onChange('llmModel', '') }}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none"
                  >
                    <option value="google">{t('settings.llmGoogle')}</option>
                    <option value="openai">{t('settings.llmOpenai')}</option>
                    <option value="anthropic">{t('settings.llmAnthropic')}</option>
                    <option value="deepseek">{t('settings.llmDeepseek')}</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.llmModel')}</label>
                  <ModelPicker
                    provider={settings.llmProvider}
                    value={settings.llmModel}
                    defaultModel={LLM_MODEL_PLACEHOLDER[settings.llmProvider] || ''}
                    onChange={id => onChange('llmModel', id)}
                  />
                  <span className="text-[10px] text-slate-400">{t('settings.llmModelHint')}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t(llmKey.label)}</label>
                  <div className="relative">
                    <Input type="password" value={settings[llmKey.field] as string} onChange={e => onChange(llmKey.field, e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder={t(llmKey.placeholder)} />
                    {(settings[llmKey.configured] as boolean) && (
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100 pointer-events-none">{t('settings.configured')}</span>
                    )}
                  </div>
                </div>

                {/* Speech service keys */}
                <div className="pt-2 pb-1 border-b border-slate-100">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{t('settings.speechKeys')}</h4>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.cartesiaApiKey')}</label>
                  <div className="relative">
                    <Input type="password" value={settings.cartesiaKey} onChange={e => onChange('cartesiaKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder={t('settings.placeholderCartesia')} />
                    {settings.cartesiaKeyConfigured && (
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100 pointer-events-none">{t('settings.configured')}</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.sonioxApiKey')}</label>
                  <div className="relative">
                    <Input type="password" value={settings.sonioxKey} onChange={e => onChange('sonioxKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder={t('settings.placeholderSoniox')} />
                    {settings.sonioxKeyConfigured && (
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100 pointer-events-none">{t('settings.configured')}</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {settings.settingsTab === 'speech' && (
              <div className="flex flex-col gap-4">
                <div className="pt-1 pb-2 border-b border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('settings.ttsSection')}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.ttsProvider')}</label>
                  <select
                    value={settings.ttsProvider}
                    onChange={e => onChange('ttsProvider', e.target.value)}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none"
                  >
                    <option value="cartesia">{t('settings.ttsCartesia')}</option>
                    <option value="cosyvoice">{t('settings.ttsCosyvoice')}</option>
                  </select>
                </div>
                {settings.ttsProvider === 'cosyvoice' && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">{t('settings.cosyvoiceModel')}</label>
                      <select
                        value={COSYVOICE_MODELS.includes(settings.cosyvoiceModel) ? settings.cosyvoiceModel : '__custom__'}
                        onChange={e => onChange('cosyvoiceModel', e.target.value === '__custom__' ? '' : e.target.value)}
                        className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none"
                      >
                        {COSYVOICE_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                        <option value="__custom__">{t('settings.customModelId')}</option>
                      </select>
                      {!COSYVOICE_MODELS.includes(settings.cosyvoiceModel) && (
                        <Input value={settings.cosyvoiceModel} onChange={e => onChange('cosyvoiceModel', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm" placeholder="cosyvoice-..." />
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">{t('settings.cosyvoiceVoice')}</label>
                      <Input
                        value={settings.cosyvoiceVoice}
                        onChange={e => onChange('cosyvoiceVoice', e.target.value)}
                        className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300"
                        placeholder={needsClonedVoice(settings.cosyvoiceModel) ? 'cosyvoice-v3.5-xxxx-...' : 'longanyang'}
                      />
                      <span className="text-[10px] text-slate-400">
                        {needsClonedVoice(settings.cosyvoiceModel)
                          ? t('settings.cosyvoiceVoiceHintCloned')
                          : t('settings.cosyvoiceVoiceHintSystem')}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">{t('settings.dashscopeApiKey')}</label>
                      <div className="relative">
                        <Input type="password" value={settings.dashscopeKey} onChange={e => onChange('dashscopeKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder="sk-..." />
                        {settings.dashscopeKeyConfigured && (
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100 pointer-events-none">{t('settings.configured')}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">{t('settings.cosyvoiceBaseUrl')}</label>
                      <Input value={settings.cosyvoiceBaseUrl} onChange={e => onChange('cosyvoiceBaseUrl', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder={COSYVOICE_BEIJING_WS} />
                      <span className="text-[10px] text-slate-400">{t('settings.cosyvoiceBaseUrlHint')}</span>
                    </div>
                  </>
                )}
                {settings.ttsProvider === 'cartesia' && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.voice')}</label>
                  <select
                    value={VOICE_PRESETS.some(v => v.id === settings.ttsVoice) ? settings.ttsVoice : '__custom__'}
                    onChange={e => {
                      if (e.target.value === '__custom__') {
                        onChange('ttsVoice', customVoiceId || '')
                      } else {
                        onChange('ttsVoice', e.target.value)
                      }
                    }}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none"
                  >
                    {VOICE_PRESETS.map(v => (
                      <option key={v.id} value={v.id}>{v.name} ({t(v.langKey)})</option>
                    ))}
                    <option value="__custom__">{t('settings.customVoice')}</option>
                  </select>
                  {!VOICE_PRESETS.some(v => v.id === settings.ttsVoice) && (
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium text-slate-500">{t('settings.customVoiceId')}</label>
                      <Input
                        value={settings.ttsVoice}
                        onChange={e => {
                          setCustomVoiceId(e.target.value)
                          onChange('ttsVoice', e.target.value)
                        }}
                        className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300 font-mono"
                        placeholder={t('settings.placeholderCustomVoice')}
                      />
                    </div>
                  )}
                </div>
                )}
                <div className="flex items-center gap-4">
                  <div className="flex-1 flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-slate-700 flex justify-between">{t('settings.volume')} <span>{settings.ttsVolume}</span></label>
                    <input type="range" min="0.5" max="2.0" step="0.1" value={settings.ttsVolume} onChange={e => onChange('ttsVolume', parseFloat(e.target.value))} className="w-full accent-slate-900" />
                  </div>
                  <div className="flex-1 flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-slate-700 flex justify-between">{t('settings.speed')} <span>{settings.ttsSpeed}</span></label>
                    <input type="range" min="0.6" max="1.5" step="0.1" value={settings.ttsSpeed} onChange={e => onChange('ttsSpeed', parseFloat(e.target.value))} className="w-full accent-slate-900" />
                  </div>
                </div>
                {settings.ttsProvider === 'cartesia' && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.emotion')}</label>
                  <select value={settings.ttsEmotion} onChange={e => onChange('ttsEmotion', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    {EMOTIONS.map(emotion => (
                      <option key={emotion} value={emotion}>{t(`emotions.${emotion}`)}</option>
                    ))}
                  </select>
                </div>
                )}
                {settings.ttsProvider === 'cartesia' && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.ttsLanguage')}</label>
                  <select value={settings.ttsLanguage} onChange={e => onChange('ttsLanguage', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    {TTS_LANGUAGES.map(lang => (
                      <option key={lang.code} value={lang.code}>{t(lang.key)}</option>
                    ))}
                  </select>
                </div>

                )}
                <div className="pt-4 pb-2 border-b border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('settings.sttSection')}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.provider')}</label>
                  <select value={settings.sttProvider} onChange={e => onChange('sttProvider', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    <option value="soniox">{t('settings.sonioxRecommended')}</option>
                    <option value="cartesia">{t('settings.cartesia')}</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.transcriptionLanguage')}</label>
                  <select value={settings.sttLanguage} onChange={e => onChange('sttLanguage', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    {TTS_LANGUAGES.map(lang => (
                      <option key={lang.code} value={lang.code}>{t(lang.key)}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {settings.settingsTab === 'hypogum' && (
              <div className="flex flex-col gap-4">
                {/* Pick which hypogum backend Molly connects to */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.hgBackendUrl')}</label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Input
                        value={settings.hypogumBaseUrl ?? ''}
                        placeholder="http://localhost:8056"
                        onChange={e => { onChange('hypogumBaseUrl', e.target.value); setHgUrlStatus('idle') }}
                        className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300 pr-24"
                      />
                      {hgUrlStatus === 'checking' && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full border border-slate-200 pointer-events-none">…</span>
                      )}
                      {hgUrlStatus === 'ok' && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100 pointer-events-none">{t('settings.hgReachable')}</span>
                      )}
                      {hgUrlStatus === 'bad' && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded-full border border-red-100 pointer-events-none">{t('settings.hgUnreachable')}</span>
                      )}
                    </div>
                    <button
                      onClick={() => refreshHypogum(settings.hypogumBaseUrl || 'http://localhost:8056')}
                      className="shrink-0 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 px-3 py-2 rounded-lg hover:bg-slate-200"
                    >
                      {t('settings.hgTest')}
                    </button>
                    <button
                      onClick={() => { onChange('hypogumBaseUrl', 'http://localhost:8056'); refreshHypogum('http://localhost:8056') }}
                      className="shrink-0 text-xs font-semibold text-slate-500 hover:text-slate-800 px-2 py-2"
                      title={t('settings.hgDetect')}
                    >
                      {t('settings.hgDetect')}
                    </button>
                  </div>
                </div>

                {hgUrlStatus === 'ok' && (
                  <>
                    <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-slate-800">{t('settings.screenObserver')}</span>
                        <span className="text-[10px] text-slate-400 mt-0.5 font-medium">{t('settings.screenObserverDesc')}</span>
                      </div>
                      <input type="checkbox" checked={hg.observe_screen_enabled === 'true'} onChange={e => hgSet('observe_screen_enabled', e.target.checked ? 'true' : 'false')} className="w-4.5 h-4.5 accent-slate-900 cursor-pointer rounded" />
                    </div>

                    <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-slate-800">{t('settings.cameraObserver')}</span>
                        <span className="text-[10px] text-slate-400 mt-0.5 font-medium">{t('settings.cameraObserverDesc')}</span>
                      </div>
                      <input type="checkbox" checked={hg.observe_camera_enabled === 'true'} onChange={e => hgSet('observe_camera_enabled', e.target.checked ? 'true' : 'false')} className="w-4.5 h-4.5 accent-slate-900 cursor-pointer rounded" />
                    </div>

                    <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                      <span className="text-xs font-bold text-slate-800">{t('settings.hgPauseWhenLocked')}</span>
                      <input type="checkbox" checked={hg.pause_when_locked !== 'false'} onChange={e => hgSet('pause_when_locked', e.target.checked ? 'true' : 'false')} className="w-4.5 h-4.5 accent-slate-900 cursor-pointer rounded" />
                    </div>

                    <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                      <span className="text-xs font-bold text-slate-800">{t('settings.hgAutoRunTasks')}</span>
                      <input type="checkbox" checked={hg.auto_run_tasks === 'true'} onChange={e => hgSet('auto_run_tasks', e.target.checked ? 'true' : 'false')} className="w-4.5 h-4.5 accent-slate-900 cursor-pointer rounded" />
                    </div>

                    <div className="flex flex-col gap-1.5 pt-2">
                      <label className="text-xs font-semibold text-slate-700 flex justify-between">
                        {t('settings.screenInterval')} <span>{hg.observe_screen_interval || 60}s</span>
                      </label>
                      <select value={hg.observe_screen_interval || '60'} onChange={e => hgSet('observe_screen_interval', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none">
                        <option value="15">{t('settings.seconds15')}</option>
                        <option value="30">{t('settings.seconds30')}</option>
                        <option value="60">{t('settings.minute1')}</option>
                        <option value="120">{t('settings.minutes2')}</option>
                        <option value="300">{t('settings.minutes5')}</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-semibold text-slate-700 flex justify-between">
                        {t('settings.cameraInterval')} <span>{hg.observe_camera_interval || 120}s</span>
                      </label>
                      <select value={hg.observe_camera_interval || '120'} onChange={e => hgSet('observe_camera_interval', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none">
                        <option value="30">{t('settings.seconds30')}</option>
                        <option value="60">{t('settings.minute1Short')}</option>
                        <option value="120">{t('settings.minutes2Default')}</option>
                        <option value="300">{t('settings.minutes5')}</option>
                        <option value="600">{t('settings.minutes10')}</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-semibold text-slate-700 flex justify-between">
                        {t('settings.processInterval')} <span>{Number(hg.process_interval || 600) / 60}m</span>
                      </label>
                      <select value={hg.process_interval || '600'} onChange={e => hgSet('process_interval', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none">
                        <option value="120">{t('settings.minutes2')}</option>
                        <option value="300">{t('settings.minutes5Default')}</option>
                        <option value="600">{t('settings.minutes10')}</option>
                        <option value="900">{t('settings.minutes15')}</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-semibold text-slate-700">{t('settings.hgWorkerModel')}</label>
                      <Input value={hg.agent_worker_model ?? ''} placeholder="deepseek/deepseek-v4-pro" onChange={e => hgSet('agent_worker_model', e.target.value)} />
                    </div>

                    <div className="flex items-center gap-2 mt-2">
                      <button onClick={saveHg} disabled={hgStatus === 'saving'} className="text-xs font-semibold text-white bg-slate-900 px-4 py-2 rounded-lg hover:bg-slate-700 disabled:opacity-50">{t('settings.hgSave')}</button>
                      {hgStatus === 'saved' && <span className="text-[11px] text-emerald-600">{t('settings.hgSaved')}</span>}
                      {hgStatus === 'error' && <span className="text-[11px] text-red-600">{t('settings.hgError')}</span>}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1">{t('settings.hgRestartNote')}</p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
