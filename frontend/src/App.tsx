import { useState, useEffect, useRef, useCallback, startTransition } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, PenSquare, Search, FileText, Clock, Bird, Mic, Volume2, VolumeX, RefreshCw, LogOut, Menu, X, ChevronDown, ArrowUp, Lightbulb, MessageCircle, Trash2 } from 'lucide-react'
import { updateObserverConfig, stopObservers } from './observers'
import { API_URL, isElectron } from './config'
import useAudioVisualizer from './hooks/useAudioVisualizer'
import useWebRTC from './hooks/useWebRTC'
import SettingsModal from './components/SettingsModal'
import Markdown from './components/Markdown'
import EmptyState from './components/EmptyState'
import ObservationCard from './components/ObservationCard'

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
  const [activeTab, setActiveTab] = useState<'chat' | 'screen' | 'camera' | 'insights' | 'memories' | 'tips'>('chat')
  const [screenCaptures, setScreenCaptures] = useState<any[]>([])
  const [cameraSnapshots, setCameraSnapshots] = useState<any[]>([])
  const [geminiInsights, setGeminiInsights] = useState<any[]>([])
  const [memories, setMemories] = useState<any[]>([])
  const [memoriesTotal, setMemoriesTotal] = useState(0)
  const [memoriesSearch, setMemoriesSearch] = useState("")
  const [memoriesTypeFilter, setMemoriesTypeFilter] = useState("")
  const [memoriesLoading, setMemoriesLoading] = useState(false)
  const [memoriesOffset, setMemoriesOffset] = useState(0)
  const memoriesOffsetRef = useRef(0)
  const [hasMoreMemories, setHasMoreMemories] = useState(true)
  const [memoriesLoadingMore, setMemoriesLoadingMore] = useState(false)

  const screenOffsetRef = useRef(0)
  const [hasMoreScreens, setHasMoreScreens] = useState(true)
  const [screensLoadingMore, setScreensLoadingMore] = useState(false)

  const cameraOffsetRef = useRef(0)
  const [hasMoreCameras, setHasMoreCameras] = useState(true)
  const [camerasLoadingMore, setCamerasLoadingMore] = useState(false)

  const insightsOffsetRef = useRef(0)
  const [hasMoreInsights, setHasMoreInsights] = useState(true)
  const [insightsLoadingMore, setInsightsLoadingMore] = useState(false)

  const tipsOffsetRef = useRef(0)
  const [hasMoreTips, setHasMoreTips] = useState(true)
  const [tipsLoadingMore, setTipsLoadingMore] = useState(false)

  const [lastRefresh, setLastRefresh] = useState(0)
  const [newMemoryText, setNewMemoryText] = useState('')
  const [newMemoryType, setNewMemoryType] = useState('other')
  const [newMemoryConfidence, setNewMemoryConfidence] = useState(10)
  const [newMemoryLifespan, setNewMemoryLifespan] = useState(10)
  const [showAddMemory, setShowAddMemory] = useState(false)
  const [addingMemory, setAddingMemory] = useState(false)
  const [proactiveTips, setProactiveTips] = useState<any[]>([])
  const [tipsLoading, setTipsLoading] = useState(false)
  const lastTipIdRef = useRef<number>(0)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileTabOpen, setMobileTabOpen] = useState(false)

  const audioBars = useAudioVisualizer(voiceMode, 5)

  const scrollRef = useRef<HTMLDivElement>(null)
  const memoriesSentinelRef = useRef<HTMLDivElement>(null)
  const screenSentinelRef = useRef<HTMLDivElement>(null)
  const cameraSentinelRef = useRef<HTMLDivElement>(null)
  const insightsSentinelRef = useRef<HTMLDivElement>(null)
  const tipsSentinelRef = useRef<HTMLDivElement>(null)
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

  // Processor scheduling — frontend triggers the backend processor on interval
  useEffect(() => {
    if (!isElectron) return;
    if (backendStatus !== 'connected' || !auth.isAuthenticated) return;
    if (!observerScreenActive && !observerCameraActive) return;
    if (isSystemIdle) return;

    const intervalMs = observerProcessInterval * 1000;
    const triggerProcessor = () => {
      auth.authFetch(`${API_URL}/api/processor/trigger`, { method: 'POST' })
        .catch(() => { });
    };
    const checkNewTips = () => {
      fetchTips(true);
    };

    triggerProcessor();
    setTimeout(checkNewTips, 15000);
    const timer = setInterval(triggerProcessor, intervalMs);
    const tipTimer = setInterval(checkNewTips, intervalMs);
    return () => { clearInterval(timer); clearInterval(tipTimer); };
  }, [backendStatus, auth.isAuthenticated, observerProcessInterval, observerScreenActive, observerCameraActive, isSystemIdle]);

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

  const fetchObservations = useCallback(async (tab: string, forceRefresh = false, append = false) => {
    try {
      const now = Date.now();
      const limit = 15;
      if (tab === 'screen') {
        const offset = append ? screenOffsetRef.current : 0;
        if (!append) { screenOffsetRef.current = 0; setHasMoreScreens(true); }
        if (append) setScreensLoadingMore(true);
        const res = await auth.authFetch(`${API_URL}/api/observations?type=screen&limit=${limit}&offset=${offset}&_=${now}`);
        if (res.ok) {
          const data = await res.json();
          const items = data.items || [];
          if (append) {
            setScreenCaptures(prev => [...prev, ...items]);
          } else {
            setScreenCaptures(items);
          }
          const nextOffset = offset + items.length;
          screenOffsetRef.current = nextOffset;
          setHasMoreScreens(nextOffset < (data.total || 0));
          if (forceRefresh) setLastRefresh(now);
        }
      } else if (tab === 'camera') {
        const offset = append ? cameraOffsetRef.current : 0;
        if (!append) { cameraOffsetRef.current = 0; setHasMoreCameras(true); }
        if (append) setCamerasLoadingMore(true);
        const res = await auth.authFetch(`${API_URL}/api/observations?type=camera&limit=${limit}&offset=${offset}&_=${now}`);
        if (res.ok) {
          const data = await res.json();
          const items = data.items || [];
          if (append) {
            setCameraSnapshots(prev => [...prev, ...items]);
          } else {
            setCameraSnapshots(items);
          }
          const nextOffset = offset + items.length;
          cameraOffsetRef.current = nextOffset;
          setHasMoreCameras(nextOffset < (data.total || 0));
          if (forceRefresh) setLastRefresh(now);
        }
      } else if (tab === 'insights') {
        const offset = append ? insightsOffsetRef.current : 0;
        if (!append) { insightsOffsetRef.current = 0; setHasMoreInsights(true); }
        if (append) setInsightsLoadingMore(true);
        const res = await auth.authFetch(`${API_URL}/api/insights?limit=${limit}&offset=${offset}&_=${now}`);
        if (res.ok) {
          const data = await res.json();
          const items = data.items || [];
          if (append) {
            setGeminiInsights(prev => [...prev, ...items]);
          } else {
            setGeminiInsights(items);
          }
          const nextOffset = offset + items.length;
          insightsOffsetRef.current = nextOffset;
          setHasMoreInsights(nextOffset < (data.total || 0));
          if (forceRefresh) setLastRefresh(now);
        }
      }
    } catch (err) {
      console.error("Failed to fetch observations or insights:", err);
    } finally {
      setScreensLoadingMore(false);
      setCamerasLoadingMore(false);
      setInsightsLoadingMore(false);
    }
  }, [auth.isAuthenticated, auth.accessToken, auth.authFetch]);

  const fetchTips = useCallback(async (checkNotifications = false, append = false) => {
    const offset = append ? tipsOffsetRef.current : 0;
    if (!append) {
      setTipsLoading(true);
      tipsOffsetRef.current = 0;
      setHasMoreTips(true);
    } else {
      setTipsLoadingMore(true);
    }
    try {
      const res = await auth.authFetch(`${API_URL}/api/proactive/tips?limit=50&offset=${offset}`);
      if (res.ok) {
        const data = await res.json();
        const tips = data.items || [];
        if (append) {
          setProactiveTips(prev => [...prev, ...tips]);
        } else {
          setProactiveTips(tips);
        }
        const nextOffset = offset + tips.length;
        tipsOffsetRef.current = nextOffset;
        setHasMoreTips(nextOffset < (data.total || 0));

        if (checkNotifications && tips.length > 0) {
          const latest = tips[0];
          if (latest.id > lastTipIdRef.current && lastTipIdRef.current > 0) {
            let tipData: any = null;
            try { tipData = JSON.parse(latest.proactive_tip || ''); } catch {}
            const tipsArr = tipData?.tips;
            const body = (tipsArr && tipsArr.length > 0 && tipsArr[0].tip_summary) || '';
            if (typeof window !== 'undefined' && (window as any).electronAPI?.showNotification) {
              (window as any).electronAPI.showNotification({ title: 'Molly\'s Tip', body });
            }
          }
          lastTipIdRef.current = Math.max(lastTipIdRef.current, ...tips.map((t: any) => t.id));
        } else if (tips.length > 0) {
          lastTipIdRef.current = Math.max(lastTipIdRef.current, ...tips.map((t: any) => t.id));
        }
      }
    } catch (err) {
      console.error("Failed to fetch tips:", err);
    } finally {
      setTipsLoading(false);
      setTipsLoadingMore(false);
    }
  }, [auth.isAuthenticated, auth.accessToken, auth.authFetch]);

  const handleChatWithTip = useCallback(async (tipItem: { goal?: string; tip_summary?: string; tip_content?: string }) => {
    try {
      const tipContent = [
        tipItem.goal,
        tipItem.tip_summary ? `**${tipItem.tip_summary}**` : '',
        tipItem.tip_content,
      ].filter(Boolean).join('\n\n');
      const userQuestion = 'What do you think? How can I act on this?';
      const title = (tipItem.tip_summary || tipItem.goal || '').replace(/[#*`_~>\[\]()]/g, '').trim().slice(0, 40);

      const createRes = await auth.authFetch(`${API_URL}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!createRes.ok) return;
      const conv = await createRes.json();

      await auth.authFetch(`${API_URL}/api/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'tip', content: tipContent }),
      });

      setMessages([
        { role: 'tip', content: tipContent },
        { role: 'user', content: userQuestion },
      ]);

      if (dcRef.current && dcRef.current.readyState === 'open') {
        setActiveConversationId(conv.id);
        dcRef.current.send(JSON.stringify({ type: 'switch_conversation', conversation_id: conv.id }));
        setTimeout(() => sendChatMessage(userQuestion), 200);
      } else {
        setActiveConversationId(conv.id);
      }

      refreshConversations();
      setActiveTab('chat');
    } catch (err) {
      console.error("Failed to chat about tip:", err);
    }
  }, [auth.authFetch, dcRef, sendChatMessage, refreshConversations]);

  const fetchMemories = useCallback(async (search?: string, append = false) => {
    const offset = append ? memoriesOffsetRef.current : 0
    if (!append) {
      setMemoriesLoading(true)
      setMemoriesOffset(0)
      memoriesOffsetRef.current = 0
    } else {
      setMemoriesLoadingMore(true)
    }
    try {
      const params = new URLSearchParams({ limit: "50" })
      params.set("offset", String(offset))
      if (search) params.set("q", search)
      if (memoriesTypeFilter) params.set("type", memoriesTypeFilter)
      const res = await auth.authFetch(`${API_URL}/api/memories?${params}`)
      if (res.ok) {
        const data = await res.json()
        if (append) {
          setMemories(prev => [...prev, ...(data.items || [])])
        } else {
          setMemories(data.items || [])
        }
        setMemoriesTotal(data.total || 0)
        const nextOffset = offset + (data.items?.length || 0)
        setMemoriesOffset(nextOffset)
        memoriesOffsetRef.current = nextOffset
        setHasMoreMemories(nextOffset < (data.total || 0))
      }
    } catch (err) {
      console.error("Failed to fetch memories:", err)
    } finally {
      setMemoriesLoading(false)
      setMemoriesLoadingMore(false)
    }
  }, [auth.authFetch, memoriesTypeFilter])

  const addMemory = useCallback(async () => {
    if (!newMemoryText.trim()) return
    setAddingMemory(true)
    try {
      const res = await auth.authFetch(`${API_URL}/api/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fact: newMemoryText.trim(),
          category: newMemoryType,
          confidence: newMemoryConfidence,
          lifespan: newMemoryLifespan,
        }),
      })
      if (res.ok) {
        setNewMemoryText('')
        setShowAddMemory(false)
        fetchMemories()
      }
    } catch (err) {
      console.error("Failed to add memory:", err)
    } finally {
      setAddingMemory(false)
    }
  }, [auth.authFetch, newMemoryText, newMemoryType, newMemoryConfidence, newMemoryLifespan, fetchMemories])

  const deleteMemory = useCallback(async (memoryId: string) => {
    try {
      const res = await auth.authFetch(`${API_URL}/api/memories/${memoryId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setMemories(prev => prev.filter(m => m.id !== memoryId))
        setMemoriesTotal(prev => Math.max(0, prev - 1))
      }
    } catch (err) {
      console.error("Failed to delete memory:", err)
    }
  }, [auth.authFetch])

  useEffect(() => {
    if (backendStatus === 'connected' && activeTab !== 'chat') {
      if (activeTab === 'memories') {
        fetchMemories()
      } else if (activeTab === 'tips') {
        fetchTips()
      } else {
        fetchObservations(activeTab)
      }
    }
  }, [activeTab, backendStatus, fetchObservations, fetchMemories, fetchTips]);

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

  useEffect(() => {
    const sentinel = screenSentinelRef.current
    if (!sentinel || !hasMoreScreens || screensLoadingMore || activeTab !== 'screen') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          fetchObservations('screen', false, true)
        }
      },
      { rootMargin: "200px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreScreens, screensLoadingMore, activeTab, fetchObservations])

  useEffect(() => {
    const sentinel = cameraSentinelRef.current
    if (!sentinel || !hasMoreCameras || camerasLoadingMore || activeTab !== 'camera') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          fetchObservations('camera', false, true)
        }
      },
      { rootMargin: "200px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreCameras, camerasLoadingMore, activeTab, fetchObservations])

  useEffect(() => {
    const sentinel = insightsSentinelRef.current
    if (!sentinel || !hasMoreInsights || insightsLoadingMore || activeTab !== 'insights') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          fetchObservations('insights', false, true)
        }
      },
      { rootMargin: "200px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreInsights, insightsLoadingMore, activeTab, fetchObservations])

  useEffect(() => {
    const sentinel = tipsSentinelRef.current
    if (!sentinel || !hasMoreTips || tipsLoadingMore || activeTab !== 'tips') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          fetchTips(false, true)
        }
      },
      { rootMargin: "200px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreTips, tipsLoadingMore, activeTab, fetchTips])

  // Listen for notification click → navigate to tips tab
  useEffect(() => {
    if (typeof window === 'undefined') return
    const api = (window as any).electronAPI
    if (!api?.onNavigateTips) return
    const unsubscribe = api.onNavigateTips(() => {
      setActiveTab('tips')
    })
    return unsubscribe
  }, [])

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
                  {(['chat', 'screen', 'camera', 'insights', 'tips', 'memories'] as const).map(tab => (
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
              {(['chat', 'screen', 'camera', 'insights', 'tips', 'memories'] as const).map(tab => (
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

        {/* Screen Tab */}
        {activeTab === 'screen' && (
        <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
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
              <EmptyState
                icon={<Clock className="w-6 h-6 text-slate-400" />}
                title={t('screen.empty')}
                hint={t('screen.emptyHint')}
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                {screenCaptures.map(cap => (
                  <ObservationCard
                    key={cap.id}
                    id={cap.id}
                    imagePath={cap.image_path}
                    timestamp={cap.timestamp}
                    processed={cap.processed}
                    sourceLabel={t('screen.source')}
                    altText={t('screen.alt')}
                    accessToken={auth.accessToken}
                    lastRefresh={lastRefresh}
                  />
                ))}
              <div ref={screenSentinelRef} className="h-1" />
              </div>
            )}
          </div>
        </div>
        )}

        {/* Camera Tab */}
        {activeTab === 'camera' && (
        <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
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
              <EmptyState
                icon={<Clock className="w-6 h-6 text-slate-400" />}
                title={t('camera.empty')}
                hint={t('camera.emptyHint')}
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                {cameraSnapshots.map(cap => (
                  <ObservationCard
                    key={cap.id}
                    id={cap.id}
                    imagePath={cap.image_path}
                    timestamp={cap.timestamp}
                    processed={cap.processed}
                    sourceLabel={t('camera.label')}
                    altText={t('camera.alt')}
                    accessToken={auth.accessToken}
                    lastRefresh={lastRefresh}
                  />
                ))}
              <div ref={cameraSentinelRef} className="h-1" />
              </div>
            )}
          </div>
        </div>
        )}

        {/* Insights Tab */}
        {activeTab === 'insights' && (
        <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
          <div className="max-w-3xl mx-auto w-full animate-in fade-in duration-300">
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
              <EmptyState
                icon={<Bird className="w-6 h-6 text-slate-400" />}
                title={t('insights.empty')}
                hint={t('insights.emptyHint')}
              />
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

                    {/* Long-Form Summary */}
                    <div className="mt-4">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('insights.activitySummary')}</span>
                      <p className="text-xs text-slate-700 leading-relaxed mt-1.5 font-medium whitespace-pre-line">
                        {ins.activity_summary}
                      </p>
                    </div>

                    {/* Parsed analysis categories */}
                    {(() => {
                      let analysis: Record<string, any[]> | null = null
                      try { if (ins.context) analysis = JSON.parse(ins.context) } catch { }
                      if (!analysis) return null

                      const catConfig: Record<string, { label: string; color: string; bg: string; border: string }> = {
                        events: { label: t('insights.events'), color: 'text-amber-700', bg: 'bg-amber-50/60', border: 'border-amber-100' },
                        personalities: { label: t('insights.personalities'), color: 'text-rose-700', bg: 'bg-rose-50/60', border: 'border-rose-100' },
                        skills: { label: t('insights.skills'), color: 'text-emerald-700', bg: 'bg-emerald-50/60', border: 'border-emerald-100' },
                        interests: { label: t('insights.interests'), color: 'text-purple-700', bg: 'bg-purple-50/60', border: 'border-purple-100' },
                        preferences: { label: t('insights.preferences'), color: 'text-blue-700', bg: 'bg-blue-50/60', border: 'border-blue-100' },
                        ownerships: { label: t('insights.ownerships'), color: 'text-slate-700', bg: 'bg-slate-50/60', border: 'border-slate-100' },
                        relationships: { label: t('insights.relationships'), color: 'text-teal-700', bg: 'bg-teal-50/60', border: 'border-teal-100' },
                        weaknesses: { label: t('insights.weaknesses'), color: 'text-red-700', bg: 'bg-red-50/60', border: 'border-red-100' },
                        goals: { label: t('insights.goals'), color: 'text-indigo-700', bg: 'bg-indigo-50/60', border: 'border-indigo-100' },
                      }

                      return (
                        <div className="mt-5 space-y-4">
                          {Object.entries(catConfig).map(([cat, cfg]) => {
                            const items = analysis?.[cat]
                            if (!items || items.length === 0) return null
                            return (
                              <div key={cat} className={`rounded-xl border ${cfg.border} ${cfg.bg} p-4`}>
                                <span className={`text-[10px] font-extrabold uppercase tracking-wider ${cfg.color}`}>
                                  {cfg.label} ({items.length})
                                </span>
                                <div className="mt-2 space-y-2">
                                  {items.map((item: any, i: number) => (
                                    <div key={i} className="flex items-start gap-2.5">
                                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-white border border-slate-200 text-[8px] font-bold text-slate-500 flex items-center justify-center mt-0.5">
                                        {item.confidence ?? '?'}
                                      </span>
                                      <div className="min-w-0">
                                        <p className="text-[11px] text-slate-800 font-semibold leading-snug">
                                          {item[Object.keys(item).find(k => k !== 'confidence' && k !== 'evidence' && k !== 'lifespan') || 0]}
                                        </p>
                                        {(() => {
                                          if (!item.evidence) return null
                                          let displayText = ''
                                          let evidenceCount = 0
                                          try {
                                            const evidenceList = JSON.parse(item.evidence)
                                            if (Array.isArray(evidenceList) && evidenceList.length > 0) {
                                              evidenceCount = evidenceList.length
                                              displayText = evidenceList[evidenceList.length - 1].text || ''
                                            }
                                          } catch {
                                            displayText = item.evidence
                                          }
                                          if (!displayText) return null
                                          return (
                                            <p className="text-[10px] text-slate-400 italic mt-0.5 leading-snug">
                                              {evidenceCount > 1
                                                ? t('insights.evidenceCount', { count: evidenceCount }) + ': '
                                                : t('insights.evidence') + ': '
                                              }
                                              {displayText}
                                            </p>
                                          )
                                        })()}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}
                  </div>
                ))}
              <div ref={insightsSentinelRef} className="h-1" />
              </div>
            )}
          </div>
        </div>
        )}

        {/* Tips Tab */}
        {activeTab === 'tips' && (
        <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
          <div className="max-w-3xl mx-auto w-full animate-in fade-in duration-300">
            <div className="flex justify-between items-center mb-8">
              <div>
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{t('tips.title')}</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">{t('tips.desc')}</p>
              </div>
              <button
                onClick={() => fetchTips()}
                className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5"
              >
                <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
              </button>
            </div>

            {(tipsLoading && proactiveTips.length === 0) ? (
              <div className="flex items-center justify-center py-16">
                <span className="flex gap-1.5">
                  <span className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
              </div>
            ) : proactiveTips.length === 0 ? (
              <EmptyState
                icon={<Lightbulb className="w-6 h-6 text-slate-400" />}
                title={t('tips.empty')}
                hint={t('tips.emptyHint')}
              />
            ) : (
              <div className="relative border-l-2 border-slate-200/80 ml-2 sm:ml-4 pl-4 sm:pl-8 space-y-6 sm:space-y-8 py-2">
                {proactiveTips.flatMap(tip => {
                  let tipData: any = null
                  try { tipData = JSON.parse(tip.proactive_tip || ''); } catch {}
                  if (!tipData) return []
                  const tipsArr: any[] = Array.isArray(tipData.tips) ? tipData.tips : (tipData.tip_summary ? [tipData] : [])
                  if (tipsArr.length === 0) return []
                  return tipsArr.map(item => ({ item, timestamp: tip.timestamp }))
                }).map(({ item, timestamp }: { item: any; timestamp: string }, i: number) => {
                  if (typeof item.goal !== 'string' || typeof item.tip_summary !== 'string' || typeof item.tip_content !== 'string') return null
                  return (
                    <div key={i} className="relative bg-white rounded-2xl border border-slate-100 p-6 shadow-sm hover:shadow-md transition-all duration-300">
                      <div className="absolute w-3.5 h-3.5 sm:w-4 sm:h-4 bg-amber-500 rounded-full -left-[26px] sm:-left-[41px] top-4 sm:top-6 border-2 sm:border-4 border-slate-50 flex items-center justify-center shadow-sm" />

                      <div className="flex flex-wrap justify-between items-center gap-2 pb-3 border-b border-slate-50">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-extrabold uppercase tracking-wider bg-amber-700 text-white px-2.5 py-0.5 rounded-md">
                            {t('insights.suggestion')}
                          </span>
                        </div>
                        <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {new Date(timestamp).toLocaleString()}
                        </span>
                      </div>

                      <div className="mt-3">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-2">{t('tips.goal')}</span>
                        <p className="text-xs text-slate-900 leading-relaxed font-medium mt-0.5">{item.goal}</p>
                      </div>

                      <div className="mt-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-2">{t('tips.nextSteps')}</span>
                        <p className="text-xs text-slate-800 leading-relaxed mt-0.5">{item.tip_summary}</p>
                      </div>

                      <div className="mt-3 bg-gradient-to-br from-amber-50/60 to-yellow-50/60 rounded-xl p-4 border border-amber-100/60">
                        <div className="flex items-center gap-1.5 mb-2">
                          <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
                          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">{t('tips.tip')}</span>
                        </div>
                        <Markdown content={item.tip_content} />
                      </div>

                      <div className="mt-4 pt-3 border-t border-slate-100 flex justify-end">
                        <button
                          onClick={() => handleChatWithTip(item)}
                          className="flex items-center gap-1.5 text-[10px] font-semibold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-3 py-1.5 rounded-full transition-all"
                        >
                          <MessageCircle className="w-3 h-3" />
                          {t('tips.chatWithTip')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              <div ref={tipsSentinelRef} className="h-1" />
              </div>
            )}
          </div>
        </div>
        )}

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
                          <p className="text-sm text-slate-800 leading-relaxed">
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
        fetchObservations={fetchObservations}
      />
    </div>
  )
}
