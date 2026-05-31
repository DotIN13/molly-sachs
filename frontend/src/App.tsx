import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, PenSquare, Search, FileText, Clock, Bird, Mic, Volume2, VolumeX, RefreshCw, LogOut, Menu, X, ChevronDown, ArrowUp } from 'lucide-react'
import { updateObserverConfig } from './observers'
import { API_URL, isElectron } from './config'
import useAudioVisualizer from './hooks/useAudioVisualizer'
import useWebRTC from './hooks/useWebRTC'
import SettingsModal from './components/SettingsModal'
import Markdown from './components/Markdown'

import { useAuth } from './contexts/AuthContext'
import Login from './pages/Login'
import 'katex/dist/katex.min.css'

export default function App() {
  const auth = useAuth()
  const { t } = useTranslation()

  const [messages, setMessages] = useState<{ role: string, content: string }[]>([
    { role: 'assistant', content: t('app.helloDefault') }
  ])
  const [input, setInput] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('general')

  const [voiceMode, setVoiceMode] = useState(false)
  const [speakText, setSpeakText] = useState(true)

  const [geminiKey, setGeminiKey] = useState('')
  const [cartesiaKey, setCartesiaKey] = useState('')
  const [sonioxKey, setSonioxKey] = useState('')
  const [geminiKeyConfigured, setGeminiKeyConfigured] = useState(false)
  const [cartesiaKeyConfigured, setCartesiaKeyConfigured] = useState(false)
  const [sonioxKeyConfigured, setSonioxKeyConfigured] = useState(false)

  const [ttsVoice, setTtsVoice] = useState('6eb8965c-e295-47bd-a9e4-3eeebb3abcff')
  const [ttsVolume, setTtsVolume] = useState(1.0)
  const [ttsSpeed, setTtsSpeed] = useState(1.0)
  const [ttsEmotion, setTtsEmotion] = useState('neutral')
  const [sttLanguage, setSttLanguage] = useState('en')
  const [sttProvider, setSttProvider] = useState('soniox')
  const [ttsLanguage, setTtsLanguage] = useState('en')
  const [backendStatus, setBackendStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking')
  const [conversations, setConversations] = useState<{ id: string, title: string, created_at: string }[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string>('')

  // Observer States
  const [observerScreenActive, setObserverScreenActive] = useState(false)
  const [observerCameraActive, setObserverCameraActive] = useState(false)
  const [observerCaptureInterval, setObserverCaptureInterval] = useState(60)
  const [observerScreenInterval, setObserverScreenInterval] = useState(60)
  const [observerCameraInterval, setObserverCameraInterval] = useState(120)
  const [observerProcessInterval, setObserverProcessInterval] = useState(300)
  const [debugMode, setDebugMode] = useState(false)
  const [timezone, setTimezone] = useState('')

  // Dashboard & Navigation States
  const [activeTab, setActiveTab] = useState<'chat' | 'screen' | 'camera' | 'insights'>('chat')
  const [screenCaptures, setScreenCaptures] = useState<any[]>([])
  const [cameraSnapshots, setCameraSnapshots] = useState<any[]>([])
  const [geminiInsights, setGeminiInsights] = useState<any[]>([])
  const [lastRefresh, setLastRefresh] = useState(0)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileTabOpen, setMobileTabOpen] = useState(false)

  const audioBars = useAudioVisualizer(voiceMode, 5)

  const scrollRef = useRef<HTMLDivElement>(null)
  const refreshConversationsRef = useRef<() => void>(() => { })
  const appliedSettingsRef = useRef<Record<string, any>>({})
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { dcRef, pcRef, disconnectWebRTC, connectWebRTC, sendChatMessage, pipelineReady } = useWebRTC({
    backendStatus,
    activeConversationId,
    setMessages,
    refreshConversationsRef,
  })

  useEffect(() => {
    let active = true;
    const checkHealth = async () => {
      try {
        const res = await fetch(`${API_URL}/api/health`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'healthy' && active) {
            setBackendStatus('connected');
            return;
          }
        }
        if (active) setBackendStatus('disconnected');
      } catch (e) {
        if (active) setBackendStatus('disconnected');
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 10000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (backendStatus !== 'connected' || !auth.isAuthenticated) return;
    auth.authFetch(`${API_URL}/api/settings`)
      .then(res => res.json())
      .then(data => {
        setGeminiKey(data.gemini_api_key || '')
        setCartesiaKey(data.cartesia_api_key || '')
        setSonioxKey(data.soniox_api_key || '')
        setGeminiKeyConfigured(data.gemini_key_configured || false)
        setCartesiaKeyConfigured(data.cartesia_key_configured || false)
        setSonioxKeyConfigured(data.soniox_key_configured || false)
        setTtsVoice(data.tts_voice || '79a125e8-cd45-4c13-8a67-188112f4dd22')
        setTtsVolume(data.tts_volume ?? 1.0)
        setTtsSpeed(data.tts_speed ?? 1.0)
        setTtsEmotion(data.tts_emotion || 'neutral')
        setSttLanguage(data.stt_language || 'en')
        setSttProvider(data.stt_provider || 'soniox')
        setTtsLanguage(data.tts_language || 'en')

        appliedSettingsRef.current = {
          geminiKey: data.gemini_api_key || '',
          cartesiaKey: data.cartesia_api_key || '',
          sonioxKey: data.soniox_api_key || '',
          ttsVoice: data.tts_voice || '79a125e8-cd45-4c13-8a67-188112f4dd22',
          ttsVolume: data.tts_volume ?? 1.0,
          ttsSpeed: data.tts_speed ?? 1.0,
          ttsEmotion: data.tts_emotion || 'neutral',
          ttsLanguage: data.tts_language || 'en',
          sttProvider: data.stt_provider || 'soniox',
          sttLanguage: data.stt_language || 'en',
        }

        // Load Observers settings
        const scrActive = data.observer_screen_active ?? false;
        const camActive = data.observer_camera_active ?? false;
        const capInt = data.observer_capture_interval ?? 60;
        const scrInt = data.observer_screen_interval ?? 60;
        const camInt = data.observer_camera_interval ?? 120;
        const procInt = data.observer_process_interval ?? 300;

        setObserverScreenActive(scrActive);
        setObserverCameraActive(camActive);
        setObserverCaptureInterval(capInt);
        setObserverScreenInterval(scrInt);
        setObserverCameraInterval(camInt);
        setObserverProcessInterval(procInt);
        setDebugMode(data.debug ?? false);
        setTimezone(data.timezone || '');

        if (!data.timezone) {
          const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
          auth.authFetch(`${API_URL}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timezone: detected })
          }).then(() => setTimezone(detected)).catch(() => { })
        }

        updateObserverConfig({
          screenActive: scrActive,
          cameraActive: camActive,
          screenInterval: scrInt,
          cameraInterval: camInt,
        });
      })
      .catch(console.error)
  }, [backendStatus, auth.isAuthenticated])

  // Processor scheduling — frontend triggers the backend processor on interval
  useEffect(() => {
    if (!isElectron) return;
    if (backendStatus !== 'connected' || !auth.isAuthenticated) return;
    if (!observerScreenActive && !observerCameraActive) return;

    const intervalMs = observerProcessInterval * 1000;
    const triggerProcessor = () => {
      auth.authFetch(`${API_URL}/api/processor/trigger`, { method: 'POST' })
        .catch(() => { });
    };

    triggerProcessor();
    const timer = setInterval(triggerProcessor, intervalMs);
    return () => clearInterval(timer);
  }, [backendStatus, auth.isAuthenticated, observerProcessInterval, observerScreenActive, observerCameraActive]);

  useEffect(() => {
    if (backendStatus !== 'connected' || !auth.isAuthenticated) return;
    auth.authFetch(`${API_URL}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_mode: voiceMode, speak_text: speakText })
    }).catch(console.error)
  }, [voiceMode, speakText, backendStatus, auth.isAuthenticated])

  const refreshConversations = useCallback(() => {
    if (!auth.isAuthenticated) return;
    auth.authFetch(`${API_URL}/api/conversations`)
      .then(res => res.json())
      .then(data => setConversations(Array.isArray(data) ? data : []))
      .catch(() => { });
  }, [auth.isAuthenticated]);
  refreshConversationsRef.current = refreshConversations;

  // Load conversations list
  useEffect(() => {
    if (backendStatus !== 'connected' || !auth.isAuthenticated) return;
    auth.authFetch(`${API_URL}/api/conversations`)
      .then(res => res.json())
      .then(data => {
        if (!Array.isArray(data)) return;
        setConversations(data);
        if (data && data.length > 0 && !activeConversationId) {
          loadConversation(data[0].id);
        } else if ((!data || data.length === 0) && !activeConversationId) {
          createNewConversation();
        }
      })
      .catch(console.error);
  }, [backendStatus, auth.isAuthenticated]);

  const loadConversation = async (id: string) => {
    try {
      // Reuse existing pipeline if connected
      if (dcRef.current && dcRef.current.readyState === 'open') {
        setActiveConversationId(id);
        dcRef.current.send(JSON.stringify({ type: 'switch_conversation', conversation_id: id }));
        return;
      }
      if (pcRef.current) disconnectWebRTC();
      setActiveConversationId(id);

      const res = await auth.authFetch(`${API_URL}/api/conversations/${id}/messages`);
      const data = await res.json();
      if (data && data.length > 0) {
        setMessages(data);
      } else {
        setMessages([
          { role: 'assistant', content: t('app.helloDefault') }
        ]);
      }
    } catch (e) {
      console.error("Failed to load conversation messages");
    }
  };

  const createNewConversation = async () => {
    try {
      const res = await auth.authFetch(`${API_URL}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      setConversations(prev => [data, ...prev]);
      if (dcRef.current && dcRef.current.readyState === 'open') {
        setActiveConversationId(data.id);
        dcRef.current.send(JSON.stringify({ type: 'switch_conversation', conversation_id: data.id }));
      } else {
        setActiveConversationId(data.id);
      }
      setMessages([
        { role: 'assistant', content: t('app.helloDefault') }
      ]);
    } catch (e) {
      console.error("Failed to create new conversation");
    }
  };

  const deleteConversation = async (id: string) => {
    try {
      await auth.authFetch(`${API_URL}/api/conversations/${id}`, {
        method: 'DELETE'
      });
      setConversations(prev => prev.filter(c => c.id !== id));
      if (activeConversationId === id) {
        const remaining = conversations.filter(c => c.id !== id);
        if (remaining.length > 0) {
          loadConversation(remaining[0].id);
        } else {
          createNewConversation();
        }
      }
    } catch (e) {
      console.error("Failed to delete conversation");
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages])

  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
  }, [input])

  const saveSettings = async () => {
    try {
      const body: Record<string, unknown> = {
        tts_voice: ttsVoice,
        tts_volume: ttsVolume,
        tts_speed: ttsSpeed,
        tts_emotion: ttsEmotion,
        stt_language: sttLanguage,
        tts_language: ttsLanguage,
        stt_provider: sttProvider,
        observer_screen_active: observerScreenActive,
        observer_camera_active: observerCameraActive,
        observer_screen_interval: observerScreenInterval,
        observer_camera_interval: observerCameraInterval,
        observer_capture_interval: observerCaptureInterval,
        observer_process_interval: observerProcessInterval
      }
      if (timezone !== undefined && timezone !== null) {
        body.timezone = timezone
      }
      if (geminiKey && geminiKey !== appliedSettingsRef.current?.geminiKey) {
        body.gemini_api_key = geminiKey
      }
      if (cartesiaKey && cartesiaKey !== appliedSettingsRef.current?.cartesiaKey) {
        body.cartesia_api_key = cartesiaKey
      }
      if (sonioxKey && sonioxKey !== appliedSettingsRef.current?.sonioxKey) {
        body.soniox_api_key = sonioxKey
      }
      await auth.authFetch(`${API_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      updateObserverConfig({
        screenActive: observerScreenActive,
        cameraActive: observerCameraActive,
        screenInterval: observerScreenInterval,
        cameraInterval: observerCameraInterval,
      })
      setIsSettingsOpen(false)

      const prev = appliedSettingsRef.current
      const curr = {
        geminiKey, cartesiaKey, sonioxKey,
        ttsVoice, ttsVolume, ttsSpeed, ttsEmotion, ttsLanguage,
        sttProvider, sttLanguage,
      }
      const keys = Object.keys(curr) as (keyof typeof curr)[]
      const pipelineChanged = keys.some(k => String(curr[k]) !== String(prev[k] ?? ''))
      if (pipelineChanged) {
        disconnectWebRTC()
        setTimeout(() => connectWebRTC(), 200)
      } else if (dcRef.current && dcRef.current.readyState === 'open') {
        dcRef.current.send(JSON.stringify({ type: 'settings_updated' }))
      }
      appliedSettingsRef.current = curr
    } catch (e) {
      console.error("Failed to save settings")
    }
  }

  const fetchObservations = useCallback(async (tab: string, forceRefresh = false) => {
    try {
      const now = Date.now();
      if (tab === 'screen') {
        const res = await auth.authFetch(`${API_URL}/api/observations?type=screen&limit=15&_=${now}`);
        if (res.ok) {
          const data = await res.json();
          setScreenCaptures(data || []);
          if (forceRefresh) setLastRefresh(now);
        }
      } else if (tab === 'camera') {
        const res = await auth.authFetch(`${API_URL}/api/observations?type=camera&limit=15&_=${now}`);
        if (res.ok) {
          const data = await res.json();
          setCameraSnapshots(data || []);
          if (forceRefresh) setLastRefresh(now);
        }
      } else if (tab === 'insights') {
        const res = await auth.authFetch(`${API_URL}/api/insights?limit=15&_=${now}`);
        if (res.ok) {
          const data = await res.json();
          setGeminiInsights(data || []);
          if (forceRefresh) setLastRefresh(now);
        }
      }
    } catch (err) {
      console.error("Failed to fetch observations or insights:", err);
    }
  }, []);

  useEffect(() => {
    if (backendStatus === 'connected' && activeTab !== 'chat') {
      fetchObservations(activeTab);
    }
  }, [activeTab, backendStatus, fetchObservations]);

  const handleSettingsChange = (key: string, value: any) => {
    const setters: Record<string, any> = {
      geminiKey: setGeminiKey,
      cartesiaKey: setCartesiaKey,
      sonioxKey: setSonioxKey,
      ttsVoice: setTtsVoice,
      ttsVolume: setTtsVolume,
      ttsSpeed: setTtsSpeed,
      ttsEmotion: setTtsEmotion,
      sttLanguage: setSttLanguage,
      sttProvider: setSttProvider,
      ttsLanguage: setTtsLanguage,
      observerScreenActive: setObserverScreenActive,
      observerCameraActive: setObserverCameraActive,
      observerCaptureInterval: setObserverCaptureInterval,
      observerScreenInterval: setObserverScreenInterval,
      observerCameraInterval: setObserverCameraInterval,
      observerProcessInterval: setObserverProcessInterval,
      settingsTab: setSettingsTab,
      timezone: setTimezone,
    }
    setters[key]?.(value)
  }

  const settingsData = {
    geminiKey, cartesiaKey, sonioxKey,
    geminiKeyConfigured, cartesiaKeyConfigured, sonioxKeyConfigured,
    ttsVoice, ttsVolume, ttsSpeed, ttsEmotion,
    sttLanguage, sttProvider, ttsLanguage,
    observerScreenActive, observerCameraActive, observerScreenInterval,
    observerCameraInterval, observerCaptureInterval, observerProcessInterval,
    settingsTab, debugMode, timezone,
  }

  const sendMessage = () => {
    if (!input.trim()) return
    setMessages(prev => [...prev, { role: 'user', content: input }])
    sendChatMessage(input)
    setInput('')
  }

  if (auth.isLoading) {
    return (
      <div className="h-dvh w-full bg-[#fafafa] flex items-center justify-center">
        <div className="text-slate-500 text-lg">{t('app.loading')}</div>
      </div>
    )
  }

  if (!auth.isAuthenticated) {
    return <Login />
  }

  return (
    <div className="h-dvh w-full bg-white flex overflow-hidden font-sans relative">

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden" onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Sidebar */}
      <div className={`border-r border-slate-100 bg-[#fafafa] flex-col pt-12 pb-4 z-50 transition-transform duration-300
        lg:flex lg:relative lg:translate-x-0 lg:w-64
        ${mobileMenuOpen ? 'fixed inset-y-0 left-0 flex translate-x-0 w-64 max-w-[85vw]' : 'hidden'}
      `}>
        <button
          className="absolute top-4 right-4 lg:hidden text-slate-500 hover:text-slate-800"
          onClick={() => setMobileMenuOpen(false)}
        >
          <X className="w-5 h-5" />
        </button>
        <div className="px-5 mb-8 flex items-center gap-3">
          <img src="./logo.jpg" alt={t('app.title')} className="w-12 h-12 rounded-full object-cover border border-slate-100 shadow-sm" />
          <span className="font-semibold text-slate-800 text-sm tracking-wide">{t('app.title')}</span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-0.5">
          <button onClick={() => { createNewConversation(); setMobileMenuOpen(false) }} className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
            <PenSquare className="w-3.5 h-3.5" /> {t('app.newChat')}
          </button>
          <button className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
            <Search className="w-3.5 h-3.5" /> {t('app.search')}
          </button>
          <button className="w-full flex items-center justify-between px-3 py-1 text-sm font-medium text-slate-800 bg-[#eef2fc] rounded-md transition-colors">
            <div className="flex items-center gap-2"><FileText className="w-3.5 h-3.5 text-blue-600" /> {t('app.activeContext')}</div>
            <span className="text-[9px] uppercase tracking-wider bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded">{t('app.beta')}</span>
          </button>
          <button className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
            <Clock className="w-3.5 h-3.5" /> {t('app.routines')}
          </button>

          <div className="pt-6 pb-2 px-3 text-[10px] uppercase font-semibold tracking-wider text-slate-400">{t('app.conversations')}</div>
          <div className="space-y-0 overflow-y-auto max-h-[300px] pr-1">
            {conversations.map(conv => (
              <div
                key={conv.id}
                className={`group w-full flex items-center justify-between px-3 py-1 rounded-md text-sm transition-all ${activeConversationId === conv.id
                  ? 'bg-[#eef2fc] text-blue-700 font-medium'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'
                  }`}
              >
                <button
                  onClick={() => { loadConversation(conv.id); setMobileMenuOpen(false) }}
                  className="flex-1 text-left truncate mr-2"
                >
                  {conv.title}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                  className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 p-0.5 rounded transition-all"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 mt-auto space-y-2">
          <button onClick={() => { setIsSettingsOpen(true); setMobileMenuOpen(false) }} className="w-full flex items-center gap-2 px-2 py-2 text-xs border border-slate-200 rounded-md shadow-sm text-slate-600 hover:bg-slate-50 transition-colors">
            <div className="w-5 h-5 rounded bg-slate-200 flex items-center justify-center text-slate-600 font-medium text-[10px]">
              {auth.user?.name?.charAt(0)?.toUpperCase() || 'U'}
            </div>
            <div className="flex flex-col items-start flex-1 text-[10px]">
              <span className="font-semibold leading-tight">{auth.user?.name || 'Settings'}</span>
              <span className="text-slate-400 leading-tight">{t('app.apiConfig')}</span>
            </div>
            <Settings className="w-3.5 h-3.5 opacity-50" />
          </button>
          <button
            onClick={auth.logout}
            className="w-full flex items-center gap-2 px-2 py-2 text-xs border border-slate-200 rounded-md shadow-sm text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition-colors"
          >
            <LogOut className="w-3 h-3" />
            <span className="text-[10px]">{t('app.signOut')}</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 bg-white flex flex-col pt-2 lg:pt-12 relative">
        {/* Header */}
        <div className="px-3 sm:px-4 lg:px-8 pt-3.5 pb-4 lg:py-4 flex items-center gap-2 lg:gap-4 border-b border-slate-100 flex-shrink-0 flex-wrap">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="lg:hidden flex items-center justify-center w-10 h-10 rounded-lg hover:bg-slate-100 text-slate-600 flex-shrink-0"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex-shrink-0 relative">
            <button
              onClick={() => setMobileTabOpen(!mobileTabOpen)}
              className="lg:hidden flex items-center gap-2 text-sm font-semibold uppercase tracking-wider bg-slate-100/80 border border-slate-200/40 rounded-xl px-4 py-2.5 shadow-inner cursor-pointer text-slate-700"
            >
              {t(`tabs.${activeTab}`)}
              <ChevronDown className={`w-4 h-4 transition-transform ${mobileTabOpen ? 'rotate-180' : ''}`} />
            </button>
            {mobileTabOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMobileTabOpen(false)} />
                <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden min-w-[140px]">
                  {(['chat', 'screen', 'camera', 'insights'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => { setActiveTab(tab); setMobileTabOpen(false) }}
                      className={`w-full text-left px-4 py-3 text-sm font-semibold uppercase tracking-wider transition-colors ${activeTab === tab
                        ? 'bg-slate-100 text-slate-900'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                        }`}
                    >
                      {t(`tabs.${tab}`)}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="hidden lg:flex overflow-x-auto gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/40 backdrop-blur-sm shadow-inner">
              {(['chat', 'screen', 'camera', 'insights'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`text-xs font-semibold px-4 py-1.5 rounded-lg transition-all uppercase tracking-wider text-[10px] whitespace-nowrap ${activeTab === tab
                    ? 'bg-slate-900 text-white shadow-md'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200/50'
                    }`}
                >
                  {t(`tabs.${tab}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap ml-auto">
            {activeTab === 'chat' && (
              <>
                <button
                  onClick={() => setSpeakText(!speakText)}
                  className={`flex items-center gap-1.5 text-xs font-medium transition-all px-3 py-2 sm:py-1.5 rounded-lg border ${speakText
                    ? 'bg-indigo-50 text-indigo-600 border-indigo-100 shadow-sm'
                    : 'bg-slate-50 text-slate-500 border-slate-200'
                    }`}
                >
                  {speakText ? <Volume2 className="w-3.5 h-3.5 text-indigo-500" /> : <VolumeX className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">{speakText ? t('app.aiSpeaking') : t('app.aiMuted')}</span>
                </button>

                <button
                  onClick={() => setMessages([])}
                  className="border border-slate-200 px-3 py-2 sm:py-1.5 rounded-lg shadow-sm hover:bg-slate-50 transition-colors text-xs font-medium text-slate-500"
                >
                  {t('app.clearChat')}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Chat Tab - original styling preserved */}
        <div className={`flex-1 overflow-y-auto px-3 md:px-8 py-9 ${activeTab === 'chat' ? '' : 'hidden'}`} ref={scrollRef}>
          <div className="flex flex-col gap-4 sm:gap-5 max-w-3xl mx-auto w-full">
            {messages.map((m, i) => (
              <div key={i} className={`flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`px-4 py-2.5 ${m.role === 'user' ? 'lux-bubble-user' : 'lux-bubble-ai'}`}>
                  {m.role === 'user' ? m.content : <Markdown content={m.content} />}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Observer Tabs Viewport */}
        <div className={`flex-1 overflow-y-auto px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40 ${activeTab !== 'chat' ? '' : 'hidden'}`}>

          <div className={`${activeTab === 'screen' ? '' : 'hidden'}`}>
            <div className="max-w-6xl mx-auto w-full animate-in fade-in duration-300">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{t('screen.title')}</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">{t('screen.desc')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => fetchObservations('screen', true)}
                    className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
                  </button>
                </div>
              </div>

              {screenCaptures.length === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[200px] sm:min-h-[350px] border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm">
                  <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
                    <Clock className="w-6 h-6 text-slate-400" />
                  </div>
                  <span className="text-slate-600 font-medium text-sm">{t('screen.empty')}</span>
                  <span className="text-[11px] text-slate-400 mt-1 max-w-xs text-center leading-normal">
                    {t('screen.emptyHint')}
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                  {screenCaptures.map(cap => (
                    <div key={cap.id} className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm bg-white hover:shadow-md transition-all hover:scale-[1.01] duration-300 group">
                      <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
                        <img
                          src={`${API_URL}/api/observations/file?path=${encodeURIComponent(cap.image_path)}&token=${encodeURIComponent(auth.accessToken ?? '')}&t=${lastRefresh}`}
                          alt={t('screen.alt')}
                          loading="lazy"
                          className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-500"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                          <span className="text-[10px] font-mono text-white/90">ID: #{cap.id}</span>
                        </div>
                      </div>
                      <div className="p-4 bg-white">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">{t('screen.source')}</span>
                          <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${cap.processed
                            ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                            : 'bg-amber-50 text-amber-600 border border-amber-100'
                            }`}>
                            {cap.processed ? t('status.processed') : t('status.pending')}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-2 font-mono flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {new Date(cap.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={`${activeTab === 'camera' ? '' : 'hidden'}`}>
            <div className="max-w-6xl mx-auto w-full animate-in fade-in duration-300">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{t('camera.title')}</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">{t('camera.desc')}</p>
                </div>
                <button
                  onClick={() => fetchObservations('camera', true)}
                  className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
                </button>
              </div>

              {cameraSnapshots.length === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[200px] sm:min-h-[350px] border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm">
                  <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
                    <Clock className="w-6 h-6 text-slate-400" />
                  </div>
                  <span className="text-slate-600 font-medium text-sm">{t('camera.empty')}</span>
                  <span className="text-[11px] text-slate-400 mt-1 max-w-xs text-center leading-normal">
                    {t('camera.emptyHint')}
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                  {cameraSnapshots.map(cap => (
                    <div key={cap.id} className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm bg-white hover:shadow-md transition-all hover:scale-[1.01] duration-300 group">
                      <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
                        <img
                          src={`${API_URL}/api/observations/file?path=${encodeURIComponent(cap.image_path)}&token=${encodeURIComponent(auth.accessToken ?? '')}&t=${lastRefresh}`}
                          alt={t('camera.alt')}
                          loading="lazy"
                          className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-500"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                          <span className="text-[10px] font-mono text-white/90">ID: #{cap.id}</span>
                        </div>
                      </div>
                      <div className="p-4 bg-white">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">{t('camera.label')}</span>
                          <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${cap.processed
                            ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                            : 'bg-amber-50 text-amber-600 border border-amber-100'
                            }`}>
                            {cap.processed ? t('status.processed') : t('status.pending')}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-2 font-mono flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {new Date(cap.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={`${activeTab === 'insights' ? '' : 'hidden'}`}>
            <div className="max-w-3xl mx-auto w-full pb-8 animate-in fade-in duration-300">
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{t('insights.title')}</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">{t('insights.desc')}</p>
                </div>
                <button
                  onClick={() => fetchObservations('insights', true)}
                  className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
                </button>
              </div>

              {geminiInsights.length === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[200px] sm:min-h-[350px] border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm">
                  <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
                    <Bird className="w-6 h-6 text-slate-400" />
                  </div>
                  <span className="text-slate-600 font-medium text-sm">{t('insights.empty')}</span>
                  <span className="text-[11px] text-slate-400 mt-1 max-w-xs text-center leading-normal">
                    {t('insights.emptyHint')}
                  </span>
                </div>
              ) : (
                <div className="relative border-l-2 border-slate-200/80 ml-2 sm:ml-4 pl-4 sm:pl-8 space-y-6 sm:space-y-8 py-2">
                  {geminiInsights.map(ins => (
                    <div key={ins.id} className="relative bg-white rounded-2xl border border-slate-100 p-6 shadow-sm hover:shadow-md transition-all duration-300">
                      <div className="absolute w-3.5 h-3.5 sm:w-4 sm:h-4 bg-slate-900 rounded-full -left-[26px] sm:-left-[41px] top-4 sm:top-6 border-2 sm:border-4 border-slate-50 flex items-center justify-center shadow-sm" />

                      <div className="flex flex-wrap justify-between items-center gap-2 pb-3 border-b border-slate-50">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider bg-slate-900 text-white px-2.5 py-0.5 rounded-md">
                          {t('insights.reportBadge', { id: ins.id })}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {new Date(ins.timestamp).toLocaleString()}
                        </span>
                      </div>

                      <div className="mt-4">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('insights.activitySummary')}</span>
                        <p className="text-xs text-slate-700 leading-relaxed mt-1.5 font-medium">
                          {ins.activity_summary}
                        </p>
                      </div>

                      {ins.context && (
                        <div className="mt-4 bg-indigo-50/50 border border-indigo-100/60 rounded-xl p-3.5 flex items-start gap-3">
                          <div className="w-5 h-5 rounded-full bg-indigo-500 text-white flex items-center justify-center flex-shrink-0 text-[10px] font-bold">
                            💡
                          </div>
                          <div>
                            <span className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-wider block">{t('insights.suggestion')}</span>
                            <span className="text-xs text-indigo-800 font-semibold italic mt-0.5 block">
                              "{ins.context}"
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Input Area */}
        <div className={`p-3 sm:p-4 lg:p-6 bg-gradient-to-t from-white via-white to-transparent flex-shrink-0 border-t border-slate-50 ${activeTab === 'chat' ? '' : 'hidden'}`}>
          <div className="max-w-2xl mx-auto flex items-end gap-2 sm:gap-2 bg-[#f9f9f9] border border-slate-200 rounded-2xl px-3 sm:px-4 py-2.5 shadow-sm focus-within:ring-1 focus-within:ring-slate-350 transition-all">
            <div className="text-slate-400 flex items-center justify-center h-10">
              <span className="text-lg leading-none mb-2 opacity-60">...</span>
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendMessage()
                }
              }}
              className="flex-1 bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0 px-2 text-slate-700 text-base shadow-none resize-none outline-none min-h-[40px] max-h-[200px] py-1.5 leading-6 hide-placeholder-mobile"
              placeholder={t('app.inputPlaceholder')}
              disabled={voiceMode}
              rows={1}
            />
            <button
              onClick={() => setVoiceMode(!voiceMode)}
              className={`flex items-center justify-center transition-all border ${voiceMode
                ? pipelineReady
                  ? 'px-3 h-10 rounded-full bg-rose-50 border-rose-200 shadow-sm gap-2 ring-1 ring-rose-100'
                  : 'px-3 h-10 rounded-full bg-amber-50 border-amber-200 shadow-sm gap-2 ring-1 ring-amber-100'
                : 'w-10 h-10 rounded-full bg-slate-50 text-slate-500 hover:text-slate-800 border-slate-200 hover:bg-slate-100'
                }`}
              title={voiceMode ? (pipelineReady ? t('app.toggleVoiceOff') : t('app.voicePreparing')) : t('app.toggleVoiceOn')}
            >
              {voiceMode ? (
                <>
                  <Mic className={`w-4 h-4 ${pipelineReady ? 'text-rose-500' : 'text-amber-500'}`} />
                  <div className="flex items-center gap-[3px] h-5 px-1">
                    {pipelineReady
                      ? audioBars.map((level, i) => (
                        <span
                          key={i}
                          className="w-[3px] rounded-full bg-rose-500/90 shadow-[0_0_8px_rgba(244,63,94,0.28)] transition-[height,opacity,transform] duration-100 ease-out"
                          style={{
                            height: `${5 + level * 18}px`,
                            opacity: 0.42 + level * 0.58,
                            transform: `scaleY(${0.92 + level * 0.12})`
                          }}
                        />
                      ))
                      : Array.from({ length: 5 }).map((_, i) => (
                        <span
                          key={i}
                          className="w-[3px] rounded-full bg-amber-400/80 animate-level-bar-idle"
                          style={{ animationDelay: `${i * 0.15}s` }}
                        />
                      ))
                    }
                  </div>
                </>
              ) : (
                <Mic className="w-4 h-4 text-slate-500" />
              )}
            </button>

            <button
              onClick={sendMessage}
              disabled={voiceMode || !input.trim()}
              className="flex items-center justify-center gap-1.5 text-sm font-semibold text-slate-700 bg-white border border-slate-200 w-10 sm:w-auto sm:px-4 h-10 rounded-full shadow-sm hover:bg-slate-50 transition-all disabled:opacity-50"
            >
              <ArrowUp className="w-5 h-5 sm:hidden" />
              <div className="w-2 h-2 bg-slate-900 rounded-sm hidden sm:block"></div>
              <span className="hidden sm:inline">{t('app.send')}</span>
            </button>
          </div>
        </div>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSave={saveSettings}
        settings={settingsData}
        onChange={handleSettingsChange}
        fetchObservations={fetchObservations}
      />
    </div>
  )
}
