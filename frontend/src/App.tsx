import { useState, useEffect, useRef, useCallback, startTransition } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, PenSquare, Search, FileText, Clock, Mic, Volume2, VolumeX, RefreshCw, LogOut, Menu, X, ChevronDown, ArrowUp, Lightbulb, Trash2 } from 'lucide-react'
import { updateObserverConfig, stopObservers } from './observers'
import { setHypogumUrl, hypogumHealthy, fetchHypogumMemories, addHypogumMemory, deleteHypogumMemory } from './hypogum'
import { API_URL, isElectron } from './config'
import useAudioVisualizer from './hooks/useAudioVisualizer'
import useWebRTC from './hooks/useWebRTC'
import SettingsModal from './components/SettingsModal'
import Markdown from './components/Markdown'
import ObserversTab from './components/ObserversTab'
import WorkTab from './components/WorkTab'
import ArtifactsTab from './components/ArtifactsTab'
import PlansTab from './components/PlansTab'
import MemoryDetailModal from './components/MemoryDetailModal'
import CalendarTab from './components/CalendarTab'

import { useAuth } from './contexts/AuthContext'
import Login from './pages/Login'
import 'katex/dist/katex.min.css'

const CATEGORY_COLORS: Record<string, string> = {
  trait: 'bg-purple-50 text-purple-700 border-purple-200',
  preference: 'bg-blue-50 text-blue-700 border-blue-200',
  interest: 'bg-green-50 text-green-700 border-green-200',
  skill: 'bg-amber-50 text-amber-700 border-amber-200',
  goal: 'bg-rose-50 text-rose-700 border-rose-200',
  relationship: 'bg-pink-50 text-pink-700 border-pink-200',
  ownership: 'bg-orange-50 text-orange-700 border-orange-200',
  weakness: 'bg-gray-50 text-gray-600 border-gray-200',
  event: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  other: 'bg-slate-50 text-slate-600 border-slate-200',
}

const MEMORY_TYPES = [
  { value: "event", label: "Events" },
  { value: "personality", label: "Personality" },
  { value: "skill", label: "Skills" },
  { value: "interest", label: "Interests" },
  { value: "preference", label: "Preferences" },
  { value: "ownership", label: "Ownership" },
  { value: "relationship", label: "Relationships" },
  { value: "weakness", label: "Weaknesses" },
  { value: "goal", label: "Goals" },
]

export default function App() {
  const auth = useAuth()
  const { t } = useTranslation()

  const [messages, setMessages] = useState<{ role: string, content: string }[]>([
    { role: 'assistant', content: t('app.helloDefault') }
  ])
  const [thinking, setThinking] = useState<{ action: string; detail: string } | null>(null)
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
  const [isSystemIdle, setIsSystemIdle] = useState(false)
  const [debugMode, setDebugMode] = useState(false)
  const [timezone, setTimezone] = useState('')

  // Dashboard & Navigation States
  const [activeTab, setActiveTab] = useState<'chat' | 'observers' | 'calendar' | 'plans' | 'work' | 'artifacts' | 'memories'>('chat')
  const [memPath, setMemPath] = useState<string | null>(null)
  const [hypogumBaseUrl, setHypogumBaseUrl] = useState('')
  const [hypogumConnected, setHypogumConnected] = useState(false)
  const [memories, setMemories] = useState<any[]>([])
  const [memoriesTotal, setMemoriesTotal] = useState(0)
  const [memoriesSearch, setMemoriesSearch] = useState("")
  const [memoriesTypeFilter, setMemoriesTypeFilter] = useState("")
  const [memoriesLoading, setMemoriesLoading] = useState(false)
  const [, setMemoriesOffset] = useState(0)
  const memoriesOffsetRef = useRef(0)
  const [hasMoreMemories, setHasMoreMemories] = useState(true)
  const [memoriesLoadingMore, setMemoriesLoadingMore] = useState(false)

  const [newMemoryText, setNewMemoryText] = useState('')
  const [newMemoryType, setNewMemoryType] = useState('other')
  const [newMemoryConfidence, setNewMemoryConfidence] = useState(10)
  const [newMemoryLifespan, setNewMemoryLifespan] = useState(10)
  const [showAddMemory, setShowAddMemory] = useState(false)
  const [addingMemory, setAddingMemory] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileTabOpen, setMobileTabOpen] = useState(false)

  const audioBars = useAudioVisualizer(voiceMode, 5)

  const scrollRef = useRef<HTMLDivElement>(null)
  const memoriesSentinelRef = useRef<HTMLDivElement>(null)
  const refreshConversationsRef = useRef<() => void>(() => { })
  const appliedSettingsRef = useRef<Record<string, any>>({})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { dcRef, pcRef, disconnectWebRTC, connectWebRTC, sendChatMessage, sendSessionState, pipelineReady } = useWebRTC({
    backendStatus,
    activeConversationId,
    setMessages,
    refreshConversationsRef,
    onThinking: (action: string, detail: string) => {
      if (thinkingTimerRef.current) {
        clearTimeout(thinkingTimerRef.current)
        thinkingTimerRef.current = null
      }
      setThinking({ action, detail })
    },
    onThinkingDone: () => {
      thinkingTimerRef.current = setTimeout(() => {
        thinkingTimerRef.current = null
        setThinking(null)
      }, 1000)
    },
  })

  useEffect(() => {
    return () => {
      if (thinkingTimerRef.current) {
        clearTimeout(thinkingTimerRef.current)
      }
    }
  }, [])

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
      } catch {
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
        setTtsVoice(data.tts_voice || '6eb8965c-e295-47bd-a9e4-3eeebb3abcff')
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
          ttsVoice: data.tts_voice || '6eb8965c-e295-47bd-a9e4-3eeebb3abcff',
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
        // Point the frontend at the user's hypogum instance (memory brain).
        setHypogumBaseUrl(data.hypogum_base_url || '');
        setHypogumUrl(data.hypogum_base_url);

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

  // System idle detection — poll every 10s and listen for immediate lock/suspend events
  useEffect(() => {
    if (!isElectron) return;
    const api = (window as any).electronAPI;
    if (!api?.getSystemIdleState) return;

    let polling = true;

    const poll = async () => {
      if (!polling) return;
      try {
        const state = await api.getSystemIdleState();
        if (state.idleState === 'locked' || state.idleState === 'idle') {
          setIsSystemIdle(true);
        } else if (state.idleState === 'active') {
          setIsSystemIdle(false);
        }
      } catch { /* ignore */ }
      if (polling) setTimeout(poll, 10000);
    };
    poll();

    const unsub = api.onSystemIdleChanged?.((data: { idle: boolean; reason: string }) => {
      console.log('[Molly] System idle changed:', data.reason, '→ idle:', data.idle);
      setIsSystemIdle(data.idle);
    });

    return () => {
      polling = false;
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  // Pause observers when system goes idle, resume when active
  useEffect(() => {
    if (!isElectron) return;
    if (isSystemIdle) {
      console.log('[Molly] System idle — pausing observers');
      stopObservers();
    } else {
      console.log('[Molly] System active — resuming observers');
      updateObserverConfig({
        screenActive: observerScreenActive,
        cameraActive: observerCameraActive,
        screenInterval: observerScreenInterval,
        cameraInterval: observerCameraInterval,
      });
    }
  }, [isSystemIdle]);


  useEffect(() => {
    if (backendStatus !== 'connected' || !auth.isAuthenticated) return;
    sendSessionState({ voice_mode: voiceMode, speak_text: speakText })
    auth.authFetch(`${API_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speak_text: speakText })
    }).catch(console.error)
  }, [voiceMode, speakText, backendStatus, auth.isAuthenticated, sendSessionState])

  const refreshConversations = useCallback(() => {
    if (!auth.isAuthenticated) return;
    auth.authFetch(`${API_URL}/api/conversations`)
      .then(res => res.json())
      .then(data => setConversations(Array.isArray(data) ? data : []))
      .catch(() => { });
  }, [auth]);

  useEffect(() => {
    refreshConversationsRef.current = refreshConversations;
  }, [refreshConversations]);

  const loadConversation = useCallback(async (id: string) => {
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
    } catch {
      console.error("Failed to load conversation messages");
    }
  }, [dcRef, pcRef, disconnectWebRTC, auth, t]);

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
    } catch {
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
    } catch {
      console.error("Failed to delete conversation");
    }
  };

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
  }, [backendStatus, auth]);

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

  const hasPipelineChanged = (curr: Record<string, any>) => {
    const prev = appliedSettingsRef.current as Record<string, any>
    const keys = Object.keys(curr)
    return keys.some(k => String(curr[k]) !== String(prev[k] ?? ''))
  }

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
        observer_process_interval: observerProcessInterval,
        hypogum_base_url: hypogumBaseUrl,
      }
      if (timezone !== undefined && timezone !== null) {
        body.timezone = timezone
      }
      // Apply the chosen hypogum backend immediately (empty → default).
      setHypogumUrl(hypogumBaseUrl)
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

      const curr = {
        geminiKey, cartesiaKey, sonioxKey,
        ttsVoice, ttsVolume, ttsSpeed, ttsEmotion, ttsLanguage,
        sttProvider, sttLanguage,
      }
      const pipelineChanged = hasPipelineChanged(curr)
      if (pipelineChanged) {
        disconnectWebRTC()
        setTimeout(() => connectWebRTC(), 200)
      } else if (dcRef.current && dcRef.current.readyState === 'open') {
        const sessionChanges: Record<string, unknown> = {}
        if (body.timezone !== undefined) sessionChanges.timezone = body.timezone
        if (body.speak_text !== undefined) sessionChanges.speak_text = body.speak_text
        if (Object.keys(sessionChanges).length > 0) {
          dcRef.current.send(JSON.stringify({ type: 'session_state_updated', changes: sessionChanges }))
        }
      }
      appliedSettingsRef.current = curr
    } catch {
      console.error("Failed to save settings")
    }
  }



  const fetchMemories = useCallback(async (search?: string, append = false) => {
    if (!append) {
      setMemoriesLoading(true)
      setMemoriesOffset(0)
      memoriesOffsetRef.current = 0
    } else {
      setMemoriesLoadingMore(true)
    }
    try {
      // Phase 3: memories come from hypogum (semantic search when querying,
      // otherwise the full page tree). No server-side pagination.
      const data = await fetchHypogumMemories(search, memoriesTypeFilter)
      if (!append) setMemories(data.items)
      setMemoriesTotal(data.total)
      setMemoriesOffset(data.items.length)
      memoriesOffsetRef.current = data.items.length
      setHasMoreMemories(false)
    } catch (err) {
      console.error("Failed to fetch memories:", err)
    } finally {
      setMemoriesLoading(false)
      setMemoriesLoadingMore(false)
    }
  }, [memoriesTypeFilter])

  const addMemory = useCallback(async () => {
    if (!newMemoryText.trim()) return
    setAddingMemory(true)
    try {
      await addHypogumMemory(
        newMemoryText.trim(), newMemoryType, newMemoryConfidence, newMemoryLifespan,
      )
      setNewMemoryText('')
      setShowAddMemory(false)
      fetchMemories()
    } catch (err) {
      console.error("Failed to add memory:", err)
    } finally {
      setAddingMemory(false)
    }
  }, [newMemoryText, newMemoryType, newMemoryConfidence, newMemoryLifespan, fetchMemories])

  const deleteMemory = useCallback(async (memoryId: string) => {
    try {
      await deleteHypogumMemory(memoryId)
      setMemories(prev => prev.filter(m => m.id !== memoryId))
      setMemoriesTotal(prev => Math.max(0, prev - 1))
    } catch (err) {
      console.error("Failed to delete memory:", err)
    }
  }, [])

  useEffect(() => {
    if (backendStatus === 'connected' && activeTab === 'memories') {
      fetchMemories()
    }
  }, [activeTab, backendStatus, fetchMemories]);

  // Memory tabs exist only while hypogum is reachable. Poll its health from the
  // configured URL; when it's unreachable, only Chat is shown (and we snap back).
  useEffect(() => {
    let stop = false
    const check = async () => {
      const url = (hypogumBaseUrl || '').trim()
      const ok = url ? await hypogumHealthy(url) : false
      if (!stop) setHypogumConnected(ok)
    }
    check()
    const timer = setInterval(check, 15000)
    return () => { stop = true; clearInterval(timer) }
  }, [hypogumBaseUrl])

  useEffect(() => {
    if (!hypogumConnected && activeTab !== 'chat') setActiveTab('chat')
  }, [hypogumConnected, activeTab])

  useEffect(() => {
    if (activeTab === 'memories' && backendStatus === 'connected') {
      fetchMemories()
    }
  }, [memoriesTypeFilter])

  useEffect(() => {
    const sentinel = memoriesSentinelRef.current
    if (!sentinel || !hasMoreMemories || memoriesLoadingMore || activeTab !== 'memories') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          fetchMemories(undefined, true)
        }
      },
      { rootMargin: "200px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreMemories, memoriesLoadingMore, activeTab, fetchMemories])

  const handleSettingsChange = (key: keyof typeof settingsData, value: any) => {
    const setters: Record<keyof typeof settingsData, any> = {
      geminiKey: setGeminiKey,
      cartesiaKey: setCartesiaKey,
      sonioxKey: setSonioxKey,
      geminiKeyConfigured: setGeminiKeyConfigured,
      cartesiaKeyConfigured: setCartesiaKeyConfigured,
      sonioxKeyConfigured: setSonioxKeyConfigured,
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
      debugMode: setDebugMode,
      timezone: setTimezone,
      hypogumBaseUrl: setHypogumBaseUrl,
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
    settingsTab, debugMode, timezone, hypogumBaseUrl,
  }

  // Memory features (all tabs except Chat, and the chat memory/run tools) light
  // up only once the user has configured a hypogum backend. Without one, Molly
  // is a plain voice/text chat client.
  const ALL_TABS = ['chat', 'observers', 'calendar', 'plans', 'work', 'artifacts', 'memories'] as const
  const visibleTabs = hypogumConnected ? ALL_TABS : (['chat'] as const)

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
                  {visibleTabs.map(tab => (
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
            <div className="hidden lg:flex overflow-x-auto gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/40 shadow-inner">
              {visibleTabs.map(tab => (
                <button
                  key={tab}
                  onClick={() => startTransition(() => setActiveTab(tab))}
                  className={`text-xs font-semibold px-4 py-1.5 rounded-lg transition-colors uppercase tracking-wider text-[10px] whitespace-nowrap ${activeTab === tab
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
        {activeTab === 'chat' && (
        <div className="flex-1 overflow-y-auto px-3 md:px-8 py-9" ref={scrollRef}>
          <div className="flex flex-col gap-4 sm:gap-5 max-w-3xl mx-auto w-full">
            {messages.map((m, i) => (
              m.role === 'tip' ? (
                <div key={i} className="bg-gradient-to-br from-amber-50/80 to-yellow-50/80 border border-amber-200/60 rounded-2xl p-5 shadow-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <Lightbulb className="w-4 h-4 text-amber-600" />
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-700">{t('insights.suggestion')}</span>
                  </div>
                  <Markdown content={m.content} />
                </div>
              ) : (
                <div key={i} className={`flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`px-4 py-2.5 ${m.role === 'user' ? 'lux-bubble-user' : 'lux-bubble-ai'}`}>
                    {m.role === 'user' ? m.content : <Markdown content={m.content} />}
                  </div>
                </div>
              )
            ))}
            {thinking && (
              <div className="flex w-full justify-start">
                <div className="px-4 py-2.5 bg-slate-100/80 rounded-2xl rounded-bl-md border border-slate-200/60 flex items-center gap-2.5">
                  <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                  <span className="text-[11px] text-slate-500 italic font-medium">
                    {thinking.action === 'searching_memory' ? t('app.searchingMemory') :
                      thinking.action === 'storing_memory' ? t('app.storingMemory') :
                        t('app.thinking')}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
        )}

        {/* Observers Tab (screen + camera) */}
        {activeTab === 'observers' && <ObserversTab />}

        {/* Calendar Tab */}
        {activeTab === 'calendar' && <CalendarTab />}

        {/* Plans Tab */}
        {activeTab === 'plans' && <PlansTab />}

        {/* Work Tab */}
        {activeTab === 'work' && <WorkTab />}

        {/* Artifacts Tab */}
        {activeTab === 'artifacts' && <ArtifactsTab />}

        {/* Memories Tab */}
        {activeTab === 'memories' && (
        <div className="overflow-y-auto flex-1 min-h-0 bg-slate-50/40">
          {/* Title — scrolls away */}
          <div className="max-w-3xl mx-auto px-3 sm:px-6 md:px-10 pt-4 sm:pt-6">
            <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{t('memories.title')}</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {memoriesTotal > 0 ? `${t('memories.total')}: ${memoriesTotal}` : t('memories.desc')}
                </p>
              </div>
              <select
                value={memoriesTypeFilter}
                onChange={e => setMemoriesTypeFilter(e.target.value)}
                className="text-[11px] bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-slate-300/50"
              >
                <option value="">{t('memories.allTypes')}</option>
                {MEMORY_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Add Memory button */}
          <div className="max-w-3xl mx-auto px-3 sm:px-6 md:px-10 pb-2">
            <button
              onClick={() => setShowAddMemory(true)}
              className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all"
            >
              <PenSquare className="w-3 h-3" />
              {t('memories.addMemory')}
            </button>
          </div>

          {/* Add Memory Modal */}
          {showAddMemory && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/10 backdrop-blur-sm animate-in fade-in" onClick={() => { setShowAddMemory(false); setNewMemoryText(''); }}>
              <div className="w-full max-w-md bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 overflow-hidden animate-in zoom-in-95" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <PenSquare className="w-4 h-4 text-slate-500" />
                    <h4 className="text-sm font-bold text-slate-800">{t('memories.addMemory')}</h4>
                  </div>
                  <button
                    onClick={() => { setShowAddMemory(false); setNewMemoryText(''); }}
                    className="text-slate-400 hover:text-slate-700 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Body */}
                <div className="px-6 py-5 space-y-4">
                  <textarea
                    value={newMemoryText}
                    onChange={e => setNewMemoryText(e.target.value)}
                    placeholder={t('memories.addPlaceholder')}
                    rows={3}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300/50 resize-none"
                    autoFocus
                  />

                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 block">{t('memories.category')}</label>
                    <select
                      value={newMemoryType}
                      onChange={e => setNewMemoryType(e.target.value)}
                      className="w-full text-xs bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-slate-300/50"
                    >
                      {MEMORY_TYPES.map(t => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('memories.confidence')}</label>
                      <span className="text-[11px] font-mono text-slate-600">{newMemoryConfidence}/10</span>
                    </div>
                    <input
                      type="range"
                      min="1" max="10"
                      value={newMemoryConfidence}
                      onChange={e => setNewMemoryConfidence(Number(e.target.value))}
                      className="w-full h-1 bg-slate-200 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-slate-600 [&::-webkit-slider-thumb]:shadow-sm [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-slate-600 [&::-moz-range-thumb]:border-0"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('memories.lifespan')}</label>
                      <span className="text-[11px] font-mono text-slate-600">{newMemoryLifespan}/10</span>
                    </div>
                    <input
                      type="range"
                      min="1" max="10"
                      value={newMemoryLifespan}
                      onChange={e => setNewMemoryLifespan(Number(e.target.value))}
                      className="w-full h-1 bg-slate-200 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-slate-600 [&::-webkit-slider-thumb]:shadow-sm [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-slate-600 [&::-moz-range-thumb]:border-0"
                    />
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center gap-2 justify-end px-6 py-4 border-t border-slate-100 bg-slate-50/50">
                  <button
                    onClick={() => { setShowAddMemory(false); setNewMemoryText(''); }}
                    className="text-xs text-slate-500 hover:text-slate-800 px-4 py-2 rounded-lg transition-colors"
                  >
                    {t('memories.cancel')}
                  </button>
                  <button
                    onClick={addMemory}
                    disabled={addingMemory || !newMemoryText.trim()}
                    className="text-xs font-semibold bg-slate-900 text-white px-5 py-2 rounded-lg hover:bg-slate-800 disabled:opacity-40 transition-all"
                  >
                    {addingMemory ? t('memories.adding') : t('memories.save')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Search bar — sticky, full width */}
          <div className="sticky top-0 z-10 px-3 sm:px-6 md:px-10 pb-3 pt-2 bg-slate-50/40 backdrop-blur-sm">
            <div className="max-w-3xl mx-auto">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                <input
                  type="text"
                  value={memoriesSearch}
                  onChange={e => setMemoriesSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') fetchMemories(memoriesSearch) }}
                  placeholder={t('memories.searchPlaceholder')}
                  className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300/50 focus:border-slate-300 transition-all"
                />
                {memoriesSearch && (
                  <button
                    onClick={() => { setMemoriesSearch(""); fetchMemories() }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-slate-200/60 flex items-center justify-center hover:bg-slate-300/60 transition"
                  >
                    <X className="w-3 h-3 text-slate-500" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Scrollable memory cards */}
          <div className="max-w-3xl mx-auto px-3 sm:px-6 md:px-10 pb-8 pt-4 sm:pt-6 animate-in fade-in duration-300">
            {(memoriesLoading && memories.length === 0) ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-5 h-5 text-slate-400 animate-spin" />
              </div>
            ) : memories.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                <PenSquare className="w-8 h-8 mb-3 text-slate-300" />
                <p className="text-sm font-medium">{t('memories.empty')}</p>
                <p className="text-[11px] mt-1">{t('memories.emptyHint')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {memories.map(mem => {
                  const color = CATEGORY_COLORS[mem.type] || CATEGORY_COLORS.other
                  return (
                    <div key={mem.id} className="group bg-white rounded-xl border border-slate-100 p-4 shadow-sm hover:shadow-md transition-shadow duration-200">
                      <div className="flex items-start gap-3">
                        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md border shrink-0 mt-0.5 ${color}`}>
                          {mem.type}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p
                            onClick={() => typeof mem.id === 'string' && mem.id.endsWith('.md') && setMemPath(mem.id)}
                            className="text-sm text-slate-800 leading-relaxed cursor-pointer hover:text-slate-950"
                            title={t('memories.viewDetail')}
                          >
                            {mem.content?.replace(/^\w+:\s*/, '') || mem.content}
                          </p>
                          <div className="flex items-center gap-3 mt-2 flex-wrap">
                            {mem.timestamp && (
                              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                                <Clock className="w-3 h-3" /> {new Date(mem.timestamp).toLocaleDateString()}
                              </span>
                            )}
                            {mem.confidence != null && (
                              <span className="text-[10px] text-slate-400">
                                {t('memories.confidence')}: {mem.confidence}/10
                              </span>
                            )}
                            {mem.lifespan != null && (
                              <span className="text-[10px] text-slate-400">
                                {t('memories.lifespan')}: {mem.lifespan}/10
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => deleteMemory(mem.id)}
                          className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 p-1 rounded transition-all shrink-0"
                          title="Delete memory"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                })}
                <div ref={memoriesSentinelRef} className="h-1" />
                {memoriesLoadingMore && (
                  <div className="flex items-center justify-center py-4">
                    <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        )}

        {memPath && (
          <MemoryDetailModal path={memPath} onClose={() => setMemPath(null)} onOpenPath={setMemPath} />
        )}

        {/* Input Area */}
        {activeTab === 'chat' && (
        <div className="p-3 sm:p-4 lg:p-6 bg-gradient-to-t from-white via-white to-transparent flex-shrink-0 border-t border-slate-50">
          <div className="max-w-2xl mx-auto flex items-end gap-2 sm:gap-2 bg-[#f9f9f9] border border-slate-200 rounded-2xl px-3 sm:px-4 py-2.5 shadow-sm focus-within:ring-1 focus-within:ring-slate-350 transition-all">
            <div className="text-slate-400 flex items-center justify-center h-10">
              <span className="text-lg leading-none mb-1 opacity-60">...</span>
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
              className="flex-1 min-w-0 bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0 px-2 text-slate-700 text-base shadow-none resize-none outline-none min-h-[38px] max-h-[200px] py-1.5 leading-6 hide-placeholder-mobile"
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
              className={`flex items-center justify-center gap-1.5 text-sm font-semibold text-slate-700 bg-white border border-slate-200 w-10 sm:w-auto sm:px-4 h-10 rounded-full shadow-sm hover:bg-slate-50 transition-all disabled:opacity-50 ${voiceMode ? 'max-sm:hidden' : ''}`}
            >
              <ArrowUp className="w-5 h-5 sm:hidden" />
              <div className="w-2 h-2 bg-slate-900 rounded-sm hidden sm:block"></div>
              <span className="hidden sm:inline">{t('app.send')}</span>
            </button>
          </div>
        </div>
        )}
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSave={saveSettings}
        settings={settingsData}
        onChange={handleSettingsChange}
      />
    </div>
  )
}
