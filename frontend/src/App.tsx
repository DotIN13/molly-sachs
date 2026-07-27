import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, PenSquare, Search, Mic, Volume2, VolumeX, LogOut, Menu, X, ArrowUp, Lightbulb, Trash2 } from 'lucide-react'
import { setHypogumUrl, hypogumHealthy, fetchHypogumMemories, addHypogumMemory, deleteHypogumMemory } from './hypogum'
import { API_URL } from './config'
import useAudioVisualizer from './hooks/useAudioVisualizer'
import useWebRTC from './hooks/useWebRTC'
import SettingsModal from './components/SettingsModal'
import Markdown from './components/Markdown'
import ObserversTab from './components/ObserversTab'
import WorkTab from './components/WorkTab'
import ArtifactsTab from './components/ArtifactsTab'
import PlansTab from './components/PlansTab'
import MemoryDetailView from './components/MemoryDetailView'
import ToolCallCard from './components/ToolCallCard'
import CalendarTab from './components/CalendarTab'

import { useAuth } from './contexts/AuthContext'
import Login from './pages/Login'
import 'katex/dist/katex.min.css'

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

  const [messages, setMessages] = useState<{ role: string, content: string, toolCallId?: string }[]>([
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

  // Chat LLM provider selection
  const [llmProvider, setLlmProvider] = useState('google')
  const [llmModel, setLlmModel] = useState('')
  // Whether the backend can still decrypt the stored API keys ("ok" |
  // "unreadable" | "no_cipher"); surfaced as a warning in Settings → API.
  const [secretsStatus, setSecretsStatus] = useState('ok')
  const [ttsProvider, setTtsProvider] = useState('cartesia')
  const [dashscopeKey, setDashscopeKey] = useState('')
  const [dashscopeKeyConfigured, setDashscopeKeyConfigured] = useState(false)
  const [cosyvoiceModel, setCosyvoiceModel] = useState('cosyvoice-v3.5-flash')
  const [cosyvoiceVoice, setCosyvoiceVoice] = useState('')
  const [cosyvoiceBaseUrl, setCosyvoiceBaseUrl] = useState('')
  const [speakerGateEnabled, setSpeakerGateEnabled] = useState(false)
  const [speakerEnrolled, setSpeakerEnrolled] = useState(false)
  const [speakerThreshold, setSpeakerThreshold] = useState(0.5)
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [deepseekKey, setDeepseekKey] = useState('')
  const [openaiKeyConfigured, setOpenaiKeyConfigured] = useState(false)
  const [anthropicKeyConfigured, setAnthropicKeyConfigured] = useState(false)
  const [deepseekKeyConfigured, setDeepseekKeyConfigured] = useState(false)

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
  const [mode, setMode] = useState<'chat' | 'work'>('chat')
  const [workView, setWorkView] = useState<'calendar' | 'observers' | 'work' | 'plans' | 'artifacts'>('calendar')
  const [convSearch, setConvSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [memPath, setMemPath] = useState<string | null>(null)
  const [hypogumBaseUrl, setHypogumBaseUrl] = useState('')
  const [hypogumConnected, setHypogumConnected] = useState(false)
  const [memories, setMemories] = useState<any[]>([])
  const [memoriesSearch, setMemoriesSearch] = useState("")

  const [newMemoryText, setNewMemoryText] = useState('')
  const [newMemoryType, setNewMemoryType] = useState('other')
  const [newMemoryConfidence, setNewMemoryConfidence] = useState(10)
  const [newMemoryLifespan, setNewMemoryLifespan] = useState(10)
  const [showAddMemory, setShowAddMemory] = useState(false)
  const [addingMemory, setAddingMemory] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const audioBars = useAudioVisualizer(voiceMode, 5)

  const scrollRef = useRef<HTMLDivElement>(null)
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
        setLlmProvider(data.llm_provider || 'google')
        setLlmModel(data.llm_model || '')
        setOpenaiKey(''); setAnthropicKey(''); setDeepseekKey('')
        setOpenaiKeyConfigured(data.openai_key_configured || false)
        setAnthropicKeyConfigured(data.anthropic_key_configured || false)
        setDeepseekKeyConfigured(data.deepseek_key_configured || false)
        setTtsVoice(data.tts_voice || '6eb8965c-e295-47bd-a9e4-3eeebb3abcff')
        setTtsVolume(data.tts_volume ?? 1.0)
        setTtsSpeed(data.tts_speed ?? 1.0)
        setTtsEmotion(data.tts_emotion || 'neutral')
        setSttLanguage(data.stt_language || 'en')
        setSttProvider(data.stt_provider || 'soniox')
        setTtsLanguage(data.tts_language || 'en')
        setTtsProvider(data.tts_provider || 'cartesia')
        setDashscopeKey('')
        setDashscopeKeyConfigured(data.dashscope_key_configured || false)
        setCosyvoiceModel(data.cosyvoice_model || 'cosyvoice-v3.5-flash')
        setCosyvoiceVoice(data.cosyvoice_voice || '')
        setCosyvoiceBaseUrl(data.cosyvoice_base_url || '')

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
          llmProvider: data.llm_provider || 'google',
          llmModel: data.llm_model || '',
          ttsProvider: data.tts_provider || 'cartesia',
          cosyvoiceModel: data.cosyvoice_model || 'cosyvoice-v3.5-flash',
          cosyvoiceVoice: data.cosyvoice_voice || '',
          cosyvoiceBaseUrl: data.cosyvoice_base_url || '',
          speakerGateEnabled: !!data.speaker_gate_enabled,
          speakerEnrolled: !!data.speaker_enrolled,
          speakerThreshold: data.speaker_threshold ?? 0.5,
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
        setSecretsStatus(data.secrets_status || 'ok');
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
      })
      .catch(console.error)
  }, [backendStatus, auth.isAuthenticated])


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
        llm_provider: llmProvider,
        llm_model: llmModel,
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
      body.tts_provider = ttsProvider
      body.cosyvoice_model = cosyvoiceModel
      body.cosyvoice_voice = cosyvoiceVoice
      body.cosyvoice_base_url = cosyvoiceBaseUrl
      body.speaker_gate_enabled = speakerGateEnabled
      body.speaker_threshold = speakerThreshold
      if (dashscopeKey) body.dashscope_api_key = dashscopeKey
      if (openaiKey) body.openai_api_key = openaiKey
      if (anthropicKey) body.anthropic_api_key = anthropicKey
      if (deepseekKey) body.deepseek_api_key = deepseekKey
      const saveRes = await auth.authFetch(`${API_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      // The backend reports whether it could actually store the API keys.
      // "secrets_replaced" means the unreadable blob was successfully replaced,
      // so the warning is cleared; "no_cipher" means the keys were NOT saved.
      const saved = await saveRes.json().catch(() => ({}))
      if (saved?.secrets_status) {
        setSecretsStatus(saved.secrets_status === 'secrets_replaced' ? 'ok' : saved.secrets_status)
      }
      setIsSettingsOpen(false)

      const curr = {
        geminiKey, cartesiaKey, sonioxKey,
        ttsVoice, ttsVolume, ttsSpeed, ttsEmotion, ttsLanguage,
        sttProvider, sttLanguage,
        llmProvider, llmModel,
        openaiKey, anthropicKey, deepseekKey,
        ttsProvider, cosyvoiceModel, cosyvoiceVoice, cosyvoiceBaseUrl, dashscopeKey,
        // Adding or removing the speaker gate changes the pipeline itself.
        speakerGateEnabled,
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



  const fetchMemories = useCallback(async (search?: string) => {
    try {
      // Memories come from hypogum (semantic search when querying, otherwise
      // the full page tree). No server-side pagination.
      const data = await fetchHypogumMemories(search)
      setMemories(data.items)
    } catch (err) {
      console.error("Failed to fetch memories:", err)
    }
  }, [])

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
    } catch (err) {
      console.error("Failed to delete memory:", err)
    }
  }, [])

  // Load the memory list whenever Work mode is active (sidebar list).
  useEffect(() => {
    if (backendStatus === 'connected' && mode === 'work') {
      fetchMemories()
    }
  }, [mode, backendStatus, fetchMemories]);

  // Work mode + its memory/tools require a reachable hypogum. Poll its health
  // from the configured URL; when unreachable, only Chat is available.
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
    if (!hypogumConnected && mode !== 'chat') setMode('chat')
  }, [hypogumConnected, mode])

  // Cmd/Ctrl+K opens the search popup (conversations in chat mode, memory pages
  // in work mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleSettingsChange = (key: keyof typeof settingsData, value: any) => {
    const setters: Record<keyof typeof settingsData, any> = {
      geminiKey: setGeminiKey,
      cartesiaKey: setCartesiaKey,
      sonioxKey: setSonioxKey,
      geminiKeyConfigured: setGeminiKeyConfigured,
      cartesiaKeyConfigured: setCartesiaKeyConfigured,
      sonioxKeyConfigured: setSonioxKeyConfigured,
      llmProvider: setLlmProvider,
      llmModel: setLlmModel,
      openaiKey: setOpenaiKey,
      anthropicKey: setAnthropicKey,
      deepseekKey: setDeepseekKey,
      openaiKeyConfigured: setOpenaiKeyConfigured,
      anthropicKeyConfigured: setAnthropicKeyConfigured,
      deepseekKeyConfigured: setDeepseekKeyConfigured,
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
      ttsProvider: setTtsProvider,
      dashscopeKey: setDashscopeKey,
      dashscopeKeyConfigured: setDashscopeKeyConfigured,
      cosyvoiceModel: setCosyvoiceModel,
      cosyvoiceVoice: setCosyvoiceVoice,
      cosyvoiceBaseUrl: setCosyvoiceBaseUrl,
      speakerGateEnabled: setSpeakerGateEnabled,
      speakerEnrolled: setSpeakerEnrolled,
      speakerThreshold: setSpeakerThreshold,
      secretsStatus: setSecretsStatus,
    }
    setters[key]?.(value)
  }

  const settingsData = {
    geminiKey, cartesiaKey, sonioxKey,
    geminiKeyConfigured, cartesiaKeyConfigured, sonioxKeyConfigured,
    llmProvider, llmModel,
    openaiKey, anthropicKey, deepseekKey,
    openaiKeyConfigured, anthropicKeyConfigured, deepseekKeyConfigured,
    ttsVoice, ttsVolume, ttsSpeed, ttsEmotion,
    sttLanguage, sttProvider, ttsLanguage,
    observerScreenActive, observerCameraActive, observerScreenInterval,
    observerCameraInterval, observerCaptureInterval, observerProcessInterval,
    settingsTab, debugMode, timezone, hypogumBaseUrl, secretsStatus,
    ttsProvider, dashscopeKey, dashscopeKeyConfigured,
    cosyvoiceModel, cosyvoiceVoice, cosyvoiceBaseUrl,
    speakerGateEnabled, speakerEnrolled, speakerThreshold,
  }

  // Memory features (all tabs except Chat, and the chat memory/run tools) light
  // up only once the user has configured a hypogum backend. Without one, Molly
  // is a plain voice/text chat client.
  const WORK_VIEWS = ['calendar', 'artifacts', 'plans', 'work', 'observers'] as const
  const MEM_GROUP_ORDER = ['goals', 'entities', 'traits', 'struggles'] as const

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

        <div className="flex-1 overflow-y-auto px-3 flex flex-col min-h-0">
          {/* Top-level mode switch: Chat / Work */}
          <div className="flex mx-1 gap-1 mb-3 bg-slate-100 rounded-lg p-0.5 border border-slate-200/60 flex-shrink-0">
            {(['chat', 'work'] as const).map(m => {
              const disabled = m === 'work' && !hypogumConnected
              return (
                <button
                  key={m}
                  disabled={disabled}
                  onClick={() => { setMode(m); setMobileMenuOpen(false) }}
                  title={disabled ? t('nav.workDisabled') : undefined}
                  className={`flex-1 text-xs font-semibold uppercase tracking-wider py-1.5 rounded-md transition-colors ${mode === m ? 'bg-white text-slate-900 shadow-sm' : disabled ? 'text-slate-300 cursor-not-allowed' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  {m === 'chat' ? t('tabs.chat') : t('nav.memoryMode')}
                </button>
              )
            })}
          </div>

          {mode === 'chat' ? (
            <div className="flex flex-col min-h-0 space-y-0.5">
              <button onClick={() => { createNewConversation(); setMobileMenuOpen(false) }} className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors flex-shrink-0">
                <PenSquare className="w-3.5 h-3.5" /> {t('app.newChat')}
              </button>
              <button onClick={() => { setConvSearch(''); setSearchOpen(true) }} className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors flex-shrink-0">
                <Search className="w-3.5 h-3.5" /> {t('app.search')}
              </button>
              <div className="pt-6 pb-2 px-3 text-[10px] uppercase font-semibold tracking-wider text-slate-400 flex-shrink-0">{t('app.conversations')}</div>
              <div className="space-y-0 overflow-y-auto pr-1">
                {conversations.map(conv => (
                  <div key={conv.id} className={`group w-full flex items-center justify-between px-3 py-1 rounded-md text-sm transition-all ${activeConversationId === conv.id ? 'bg-[#eef2fc] text-blue-700 font-medium' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'}`}>
                    <button onClick={() => { loadConversation(conv.id); setMobileMenuOpen(false) }} className="flex-1 text-left truncate mr-2">{conv.title}</button>
                    <button onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 p-0.5 rounded transition-all">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col min-h-0 space-y-0.5">
              <button onClick={() => { setMemoriesSearch(''); setSearchOpen(true) }} className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors flex-shrink-0">
                <Search className="w-3.5 h-3.5" /> {t('app.search')}
              </button>
              {/* Memory pages */}
              <div className="pt-6 pb-2 px-3 text-[10px] uppercase font-semibold tracking-wider text-slate-400 flex-shrink-0">{t('memories.title')}</div>
              <div className="space-y-0 overflow-y-auto pr-1">
                {memories.length === 0 ? (
                  <p className="px-3 py-2 text-[11px] text-slate-400">{t('memories.empty')}</p>
                ) : (() => {
                  const grouped: Record<string, typeof memories> = {}
                  for (const m of memories) (grouped[m.group] ||= []).push(m)
                  const order = [
                    ...MEM_GROUP_ORDER.filter(g => grouped[g]),
                    ...Object.keys(grouped).filter(g => !(MEM_GROUP_ORDER as readonly string[]).includes(g)),
                  ]
                  return order.map(g => (
                    <div key={g} className="mb-1">
                      <div className="px-3 pt-1.5 pb-0.5 text-[9px] uppercase font-semibold tracking-wider text-slate-400/70">
                        {t(`memoryGroups.${g}`, g)}
                      </div>
                      {grouped[g].map(mem => (
                        <div key={mem.id} className={`group w-full flex items-center justify-between px-3 py-1 rounded-md text-sm transition-all ${memPath === mem.id ? 'bg-[#eef2fc] text-blue-700 font-medium' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'}`}>
                          <button onClick={() => { if (typeof mem.id === 'string' && mem.id.endsWith('.md')) setMemPath(mem.id) }} className="flex-1 text-left truncate mr-2" title={mem.content}>
                            {(mem.content || '').replace(/^\w+:\s*/, '') || mem.content}
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); deleteMemory(mem.id) }} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 p-0.5 rounded transition-all">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ))
                })()}
              </div>
            </div>
          )}
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
          {mode === 'chat' ? (
            <div className="flex-shrink-0 text-sm font-semibold uppercase tracking-wider text-slate-700">
              {t('tabs.chat')}
            </div>
          ) : (
            <div className="flex overflow-x-auto gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/40 shadow-inner">
              {WORK_VIEWS.map(v => (
                <button
                  key={v}
                  onClick={() => { setWorkView(v); setMemPath(null) }}
                  className={`text-xs font-semibold px-4 py-1.5 rounded-lg transition-colors uppercase tracking-wider text-[10px] whitespace-nowrap ${workView === v && !memPath
                    ? 'bg-slate-900 text-white shadow-md'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200/50'
                    }`}
                >
                  {t(`tabs.${v}`)}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap ml-auto">
            {mode === 'chat' && (
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
        {mode === 'chat' && (
        <div className="flex-1 overflow-y-auto px-3 md:px-8 py-9" ref={scrollRef}>
          <div className="flex flex-col gap-4 sm:gap-5 max-w-3xl mx-auto w-full">
            {messages.map((m, i) => (
              m.role === 'tool' ? (
                <ToolCallCard key={m.toolCallId || i} content={m.content} />
              ) : m.role === 'tip' ? (
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

        {/* Memory page detail (main view + editing) */}
        {mode === 'work' && memPath && (
          <MemoryDetailView path={memPath} onClose={() => setMemPath(null)} />
        )}

        {/* Work views (hidden while a memory page is open) */}
        {mode === 'work' && !memPath && workView === 'observers' && <ObserversTab />}
        {mode === 'work' && !memPath && workView === 'calendar' && <CalendarTab />}
        {mode === 'work' && !memPath && workView === 'plans' && <PlansTab />}
        {mode === 'work' && !memPath && workView === 'work' && <WorkTab />}
        {mode === 'work' && !memPath && workView === 'artifacts' && <ArtifactsTab />}

        {/* Search Popup (⌘K) — conversations in chat mode, memory pages in work mode */}
        {searchOpen && (
          <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-slate-900/10 backdrop-blur-sm animate-in fade-in" onClick={() => setSearchOpen(false)}>
            <div className="w-full max-w-lg bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 overflow-hidden animate-in zoom-in-95" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2.5 px-4 border-b border-slate-100">
                <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <input
                  autoFocus
                  value={mode === 'chat' ? convSearch : memoriesSearch}
                  onChange={e => (mode === 'chat' ? setConvSearch(e.target.value) : setMemoriesSearch(e.target.value))}
                  onKeyDown={e => {
                    if (e.key === 'Escape') setSearchOpen(false)
                    if (e.key === 'Enter' && mode === 'work') fetchMemories(memoriesSearch)
                  }}
                  placeholder={mode === 'chat' ? t('app.search') : t('memories.searchPlaceholder')}
                  className="flex-1 py-3.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none bg-transparent"
                />
                <kbd className="text-[10px] text-slate-400 border border-slate-200 rounded px-1.5 py-0.5 flex-shrink-0">ESC</kbd>
              </div>
              <div className="max-h-[50vh] overflow-y-auto py-1.5">
                {mode === 'chat' ? (
                  (() => {
                    const items = conversations.filter(c => !convSearch.trim() || (c.title || '').toLowerCase().includes(convSearch.toLowerCase()))
                    return items.length === 0 ? (
                      <p className="px-4 py-6 text-center text-xs text-slate-400">{t('app.conversations')}: 0</p>
                    ) : items.map(conv => (
                      <button key={conv.id} onClick={() => { loadConversation(conv.id); setSearchOpen(false); setMobileMenuOpen(false) }}
                        className={`w-full text-left px-4 py-2 text-sm truncate transition-colors ${activeConversationId === conv.id ? 'bg-[#eef2fc] text-blue-700 font-medium' : 'text-slate-700 hover:bg-slate-50'}`}>
                        {conv.title}
                      </button>
                    ))
                  })()
                ) : (
                  memories.length === 0 ? (
                    <p className="px-4 py-6 text-center text-xs text-slate-400">{t('memories.empty')}</p>
                  ) : memories.map(mem => (
                    <button key={mem.id} onClick={() => { if (typeof mem.id === 'string' && mem.id.endsWith('.md')) { setMemPath(mem.id); setSearchOpen(false); setMobileMenuOpen(false) } }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 truncate transition-colors" title={mem.content}>
                      {(mem.content || '').replace(/^\w+:\s*/, '') || mem.content}
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

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

        {/* Input Area */}
        {mode === 'chat' && (
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
