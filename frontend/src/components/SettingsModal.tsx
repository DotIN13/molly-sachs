import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { triggerObservationsCapture } from '../observers'
import { API_URL, isElectron } from '../config'

const VOICE_PRESETS = [
  { id: '6eb8965c-e295-47bd-a9e4-3eeebb3abcff', name: 'Jing - Clear Coordinator', langKey: 'voiceLang.cn' },
  { id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', name: 'Skylar - Friendly Guide', langKey: 'voiceLang.enUS' },
  { id: '62ae83ad-4f6a-430b-af41-a9bede9286ca', name: 'Gemma - Decisive Agent', langKey: 'voiceLang.enGB' },
  { id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02', name: 'Katie - Friendly Fixer', langKey: 'voiceLang.enUS' },
  { id: 'ef191366-f52f-447a-a398-ed8c0f2943a1', name: 'Archie - Approachable Mate', langKey: 'voiceLang.enGB' },
  { id: '78386a09-04ef-484d-9b9d-efd13087b792', name: 'Lee - Adorable Friend', langKey: 'voiceLang.cn' },
]

const TTS_LANGUAGES = [
  { code: 'en', key: 'languages.en' }, { code: 'zh', key: 'languages.zh' }, { code: 'ja', key: 'languages.ja' },
  { code: 'es', key: 'languages.es' }, { code: 'fr', key: 'languages.fr' }, { code: 'de', key: 'languages.de' },
  { code: 'pt', key: 'languages.pt' }, { code: 'it', key: 'languages.it' },
]

const EMOTIONS = ['calm', 'happy', 'excited', 'enthusiastic', 'curious', 'content', 'peaceful', 'serene', 'grateful', 'affectionate', 'flirtatious', 'sarcastic', 'sad', 'wistful', 'apologetic', 'confident', 'neutral']

export interface SettingsData {
  geminiKey: string
  cartesiaKey: string
  sonioxKey: string
  ttsVoice: string
  ttsVolume: number
  ttsSpeed: number
  ttsEmotion: string
  sttLanguage: string
  sttProvider: string
  ttsLanguage: string
  observerScreenActive: boolean
  observerCameraActive: boolean
  observerScreenInterval: number
  observerCameraInterval: number
  observerCaptureInterval: number
  observerProcessInterval: number
  settingsTab: string
  debugMode: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: () => Promise<void>
  settings: SettingsData
  onChange: (key: string, value: any) => void
  fetchObservations: (tab: string, force?: boolean) => void
}

export default function SettingsModal({ isOpen, onClose, onSave, settings, onChange, fetchObservations }: Props) {
  const { t } = useTranslation()
  const [customVoiceId, setCustomVoiceId] = useState('')

  if (!isOpen) return null

  const handleClose = () => {
    onSave()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/10 backdrop-blur-sm animate-in fade-in" onClick={handleClose}>
      <div className="w-full max-w-2xl bg-white rounded-xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 animate-in zoom-in-95 flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="flex flex-1 overflow-hidden flex-col lg:flex-row">
          <div className="flex-shrink-0 bg-slate-50 border-b border-slate-100 lg:border-b-0 lg:border-r lg:w-48 px-3 py-2 lg:py-8 flex flex-row lg:flex-col gap-1 overflow-x-auto lg:overflow-y-auto">
            <button onClick={() => onChange('settingsTab', 'speech')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${settings.settingsTab === 'speech' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>{t('settings.speech')}</button>
            {isElectron && (
              <button onClick={() => onChange('settingsTab', 'observers')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${settings.settingsTab === 'observers' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>{t('settings.observers')}</button>
            )}
            <button onClick={() => onChange('settingsTab', 'api')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${settings.settingsTab === 'api' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>{t('settings.apiConfig')}</button>
          </div>

          <div className="flex-1 px-4 sm:px-6 py-4 sm:py-10 overflow-y-auto">
            {settings.settingsTab === 'api' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.geminiApiKey')}</label>
                  <Input type="password" value={settings.geminiKey} onChange={e => onChange('geminiKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder={t('settings.placeholderGemini')} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.cartesiaApiKey')}</label>
                  <Input type="password" value={settings.cartesiaKey} onChange={e => onChange('cartesiaKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder={t('settings.placeholderCartesia')} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.sonioxApiKey')}</label>
                  <Input type="password" value={settings.sonioxKey} onChange={e => onChange('sonioxKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder={t('settings.placeholderSoniox')} />
                </div>
              </div>
            )}

            {settings.settingsTab === 'speech' && (
              <div className="flex flex-col gap-4">
                <div className="pt-1 pb-2 border-b border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('settings.ttsSection')}</span>
                </div>
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
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.emotion')}</label>
                  <select value={settings.ttsEmotion} onChange={e => onChange('ttsEmotion', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    {EMOTIONS.map(emotion => (
                      <option key={emotion} value={emotion}>{t(`emotions.${emotion}`)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">{t('settings.ttsLanguage')}</label>
                  <select value={settings.ttsLanguage} onChange={e => onChange('ttsLanguage', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    {TTS_LANGUAGES.map(lang => (
                      <option key={lang.code} value={lang.code}>{t(lang.key)}</option>
                    ))}
                  </select>
                </div>

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

            {settings.settingsTab === 'observers' && (
              <div className="flex flex-col gap-4 animate-in fade-in duration-200">
                <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-slate-800">{t('settings.screenObserver')}</span>
                    <span className="text-[10px] text-slate-400 mt-0.5 font-medium">{t('settings.screenObserverDesc')}</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.observerScreenActive}
                    onChange={e => onChange('observerScreenActive', e.target.checked)}
                    className="w-4.5 h-4.5 accent-slate-900 cursor-pointer rounded"
                  />
                </div>

                <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-slate-800">{t('settings.cameraObserver')}</span>
                    <span className="text-[10px] text-slate-400 mt-0.5 font-medium">{t('settings.cameraObserverDesc')}</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.observerCameraActive}
                    onChange={e => onChange('observerCameraActive', e.target.checked)}
                    className="w-4.5 h-4.5 accent-slate-900 cursor-pointer rounded"
                  />
                </div>

                <div className="flex flex-col gap-1.5 pt-2">
                  <label className="text-xs font-semibold text-slate-700 flex justify-between">
                    {t('settings.screenInterval')} <span>{settings.observerScreenInterval}s</span>
                  </label>
                  <select
                    value={settings.observerScreenInterval}
                    onChange={e => onChange('observerScreenInterval', parseInt(e.target.value))}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none"
                  >
                    <option value={15}>{t('settings.seconds15')}</option>
                    <option value={30}>{t('settings.seconds30')}</option>
                    <option value={60}>{t('settings.minute1')}</option>
                    <option value={120}>{t('settings.minutes2')}</option>
                    <option value={300}>{t('settings.minutes5')}</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5 pt-2">
                  <label className="text-xs font-semibold text-slate-700 flex justify-between">
                    {t('settings.cameraInterval')} <span>{settings.observerCameraInterval}s</span>
                  </label>
                  <select
                    value={settings.observerCameraInterval}
                    onChange={e => onChange('observerCameraInterval', parseInt(e.target.value))}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none"
                  >
                    <option value={30}>{t('settings.seconds30')}</option>
                    <option value={60}>{t('settings.minute1Short')}</option>
                    <option value={120}>{t('settings.minutes2Default')}</option>
                    <option value={300}>{t('settings.minutes5')}</option>
                    <option value={600}>{t('settings.minutes10')}</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-slate-700 flex justify-between">
                    {t('settings.processInterval')} <span>{settings.observerProcessInterval / 60}m</span>
                  </label>
                  <select
                    value={settings.observerProcessInterval}
                    onChange={e => onChange('observerProcessInterval', parseInt(e.target.value))}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none"
                  >
                    <option value={120}>{t('settings.minutes2')}</option>
                    <option value={300}>{t('settings.minutes5Default')}</option>
                    <option value={600}>{t('settings.minutes10')}</option>
                    <option value={900}>{t('settings.minutes15')}</option>
                  </select>
                </div>

                {settings.debugMode && (
                  <div className="flex flex-col gap-2 pt-4 border-t border-amber-200 mt-2">
                    <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" /> {t('settings.debugActions')}
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={async () => { await triggerObservationsCapture(); fetchObservations('screen', true) }}
                        className="text-[10px] font-semibold text-amber-700 hover:text-amber-900 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg transition-all"
                      >
                        {t('settings.captureNow')}
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            const token = (() => { try { return localStorage.getItem('molly_access_token') } catch { return null } })()
                            await fetch(`${API_URL}/api/processor/trigger`, {
                              method: 'POST',
                              headers: token ? { Authorization: `Bearer ${token}` } : {},
                            })
                            fetchObservations('insights', true)
                          } catch (e) { console.error('Processor trigger failed:', e) }
                        }}
                        className="text-[10px] font-semibold text-amber-700 hover:text-amber-900 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg transition-all"
                      >
                        {t('settings.processNow')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
