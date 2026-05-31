import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { triggerObservationsCapture } from '../observers'
import { API_URL, isElectron } from '../config'

const VOICE_PRESETS = [
  { id: '6eb8965c-e295-47bd-a9e4-3eeebb3abcff', name: 'Jing - Clear Coordinator', label: 'Clear Mandarin female for reliable business communication.', lang: 'Chinese, Mandarin' },
  { id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', name: 'Skylar - Friendly Guide', label: 'Approachable American female ideal for customer care and support.', lang: 'English, American' },
  { id: '62ae83ad-4f6a-430b-af41-a9bede9286ca', name: 'Gemma - Decisive Agent', label: 'Confident, emotive British female for professional assistance.', lang: 'English, British' },
  { id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02', name: 'Katie - Friendly Fixer', label: 'Enunciating young adult female for conversational support use cases.', lang: 'English, American' },
  { id: 'ef191366-f52f-447a-a398-ed8c0f2943a1', name: 'Archie - Approachable Mate', label: 'Warm, conversational British male for casual and engaging dialogue.', lang: 'English, British' },
  { id: '78386a09-04ef-484d-9b9d-efd13087b792', name: 'Lee - Adorable Friend', label: 'Chinese Mandarin voice.', lang: 'Chinese, Mandarin' },
]

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
  const [customVoiceId, setCustomVoiceId] = useState('')

  if (!isOpen) return null

  const handleClose = () => {
    onSave()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/10 backdrop-blur-sm animate-in fade-in" onClick={handleClose}>
      <div className="w-full max-w-2xl bg-white rounded-xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 animate-in zoom-in-95 flex flex-col h-[500px]" onClick={e => e.stopPropagation()}>
        <div className="flex flex-1 overflow-hidden">
          <div className="w-48 bg-slate-50 border-r border-slate-100 px-3 py-8 flex flex-col gap-1 overflow-y-auto">
            <button onClick={() => onChange('settingsTab', 'speech')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${settings.settingsTab === 'speech' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>Speech</button>
            {isElectron && (
              <button onClick={() => onChange('settingsTab', 'observers')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${settings.settingsTab === 'observers' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>Observers</button>
            )}
            <button onClick={() => onChange('settingsTab', 'api')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${settings.settingsTab === 'api' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>API Config</button>
          </div>

          <div className="flex-1 px-6 py-10 overflow-y-auto">
            {settings.settingsTab === 'api' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">Gemini API Key</label>
                  <Input type="password" value={settings.geminiKey} onChange={e => onChange('geminiKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder="AIzaSy..." />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">Cartesia API Key (TTS)</label>
                  <Input type="password" value={settings.cartesiaKey} onChange={e => onChange('cartesiaKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder="sk-..." />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">Soniox API Key (STT)</label>
                  <Input type="password" value={settings.sonioxKey} onChange={e => onChange('sonioxKey', e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder="soniox-..." />
                </div>
              </div>
            )}

            {settings.settingsTab === 'speech' && (
              <div className="flex flex-col gap-4">
                <div className="pt-1 pb-2 border-b border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Speech Output (TTS)</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">Voice</label>
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
                      <option key={v.id} value={v.id}>{v.name} ({v.lang})</option>
                    ))}
                    <option value="__custom__">Custom...</option>
                  </select>
                  {!VOICE_PRESETS.some(v => v.id === settings.ttsVoice) && (
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium text-slate-500">Custom Voice ID</label>
                      <Input
                        value={settings.ttsVoice}
                        onChange={e => {
                          setCustomVoiceId(e.target.value)
                          onChange('ttsVoice', e.target.value)
                        }}
                        className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300 font-mono"
                        placeholder="6eb8965c-e295-..."
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex-1 flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-slate-700 flex justify-between">Volume <span>{settings.ttsVolume}</span></label>
                    <input type="range" min="0.5" max="2.0" step="0.1" value={settings.ttsVolume} onChange={e => onChange('ttsVolume', parseFloat(e.target.value))} className="w-full accent-slate-900" />
                  </div>
                  <div className="flex-1 flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-slate-700 flex justify-between">Speed <span>{settings.ttsSpeed}</span></label>
                    <input type="range" min="0.6" max="1.5" step="0.1" value={settings.ttsSpeed} onChange={e => onChange('ttsSpeed', parseFloat(e.target.value))} className="w-full accent-slate-900" />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">Emotion</label>
                  <select value={settings.ttsEmotion} onChange={e => onChange('ttsEmotion', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    {['calm', 'happy', 'excited', 'enthusiastic', 'curious', 'content', 'peaceful', 'serene', 'grateful', 'affectionate', 'flirtatious', 'sarcastic', 'sad', 'wistful', 'apologetic', 'confident', 'neutral'].map(emotion => (
                      <option key={emotion} value={emotion}>{emotion.charAt(0).toUpperCase() + emotion.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">TTS Language</label>
                  <select value={settings.ttsLanguage} onChange={e => onChange('ttsLanguage', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    {[
                      { code: 'en', label: 'English' }, { code: 'zh', label: 'Chinese' }, { code: 'ja', label: 'Japanese' },
                      { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
                      { code: 'pt', label: 'Portuguese' }, { code: 'it', label: 'Italian' }
                    ].map(lang => (
                      <option key={lang.code} value={lang.code}>{lang.label}</option>
                    ))}
                  </select>
                </div>

                <div className="pt-4 pb-2 border-b border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Speech Input (STT)</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">Provider</label>
                  <select value={settings.sttProvider} onChange={e => onChange('sttProvider', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    <option value="soniox">Soniox (Recommended)</option>
                    <option value="cartesia">Cartesia</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-700">Transcription Language</label>
                  <select value={settings.sttLanguage} onChange={e => onChange('sttLanguage', e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                    {[
                      { code: 'en', label: 'English' }, { code: 'zh', label: 'Chinese' }, { code: 'ja', label: 'Japanese' },
                      { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
                      { code: 'pt', label: 'Portuguese' }, { code: 'it', label: 'Italian' }
                    ].map(lang => (
                      <option key={lang.code} value={lang.code}>{lang.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {settings.settingsTab === 'observers' && (
              <div className="flex flex-col gap-4 animate-in fade-in duration-200">
                <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-slate-800">Screen Capture Observer</span>
                    <span className="text-[10px] text-slate-400 mt-0.5 font-medium">Periodically capture your active workspace</span>
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
                    <span className="text-xs font-bold text-slate-800">Camera Snaps Observer</span>
                    <span className="text-[10px] text-slate-400 mt-0.5 font-medium">Periodically capture camera frame</span>
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
                    Screen Capture Interval <span>{settings.observerScreenInterval}s</span>
                  </label>
                  <select
                    value={settings.observerScreenInterval}
                    onChange={e => onChange('observerScreenInterval', parseInt(e.target.value))}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none"
                  >
                    <option value={15}>15 Seconds</option>
                    <option value={30}>30 Seconds</option>
                    <option value={60}>1 Minute (Default)</option>
                    <option value={120}>2 Minutes</option>
                    <option value={300}>5 Minutes</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5 pt-2">
                  <label className="text-xs font-semibold text-slate-700 flex justify-between">
                    Camera Capture Interval <span>{settings.observerCameraInterval}s</span>
                  </label>
                  <select
                    value={settings.observerCameraInterval}
                    onChange={e => onChange('observerCameraInterval', parseInt(e.target.value))}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none"
                  >
                    <option value={30}>30 Seconds</option>
                    <option value={60}>1 Minute</option>
                    <option value={120}>2 Minutes (Default)</option>
                    <option value={300}>5 Minutes</option>
                    <option value={600}>10 Minutes</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-slate-700 flex justify-between">
                    Gemini Processing Interval <span>{settings.observerProcessInterval / 60}m</span>
                  </label>
                  <select
                    value={settings.observerProcessInterval}
                    onChange={e => onChange('observerProcessInterval', parseInt(e.target.value))}
                    className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none"
                  >
                    <option value={120}>2 Minutes</option>
                    <option value={300}>5 Minutes (Default)</option>
                    <option value={600}>10 Minutes</option>
                    <option value={900}>15 Minutes</option>
                  </select>
                </div>

                {settings.debugMode && (
                  <div className="flex flex-col gap-2 pt-4 border-t border-amber-200 mt-2">
                    <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" /> Debug Actions
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={async () => { await triggerObservationsCapture(); fetchObservations('screen', true) }}
                        className="text-[10px] font-semibold text-amber-700 hover:text-amber-900 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg transition-all"
                      >
                        Capture Now
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
                        Process Now
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
