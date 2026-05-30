import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Settings, PenSquare, Search, FileText, Clock, Bird, Mic, Volume2, VolumeX, RefreshCw } from 'lucide-react'
import { updateObserverConfig, triggerObservationsCapture } from './observers'
import { API_URL, isElectron } from './config'

function useAudioVisualizer(active: boolean, barCount = 9): number[] {
  const IDLE_BASE = 0.15

  const [bars, setBars] = useState<number[]>(Array(barCount).fill(IDLE_BASE))

  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number>(0)

  const timeDataRef = useRef<Uint8Array | null>(null)
  const displayRef = useRef<number[]>(Array(barCount).fill(IDLE_BASE))
  const targetRef = useRef<number[]>(Array(barCount).fill(IDLE_BASE))
  const phaseRef = useRef(0)

  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(frameRef.current)
      setBars(Array(barCount).fill(IDLE_BASE))
      displayRef.current = Array(barCount).fill(IDLE_BASE)
      targetRef.current = Array(barCount).fill(IDLE_BASE)
      phaseRef.current = 0
      return
    }

    let running = true

    const NOISE_GATE = 0.12
    const ACTIVE_PHASE_SPEED = 0.075
    const RELEASE_EASING = 0.08
    const ATTACK_EASING = 0.32

    const setup = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        })

        if (!running) {
          stream.getTracks().forEach(track => track.stop())
          return
        }

        streamRef.current = stream

        const AudioContextClass =
          window.AudioContext || (window as any).webkitAudioContext

        const ctx = new AudioContextClass()
        audioCtxRef.current = ctx

        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.82
        analyserRef.current = analyser

        const source = ctx.createMediaStreamSource(stream)
        source.connect(analyser)

        timeDataRef.current = new Uint8Array(analyser.fftSize)

        const tick = () => {
          if (!running || !analyser || !timeDataRef.current) return

          analyser.getByteTimeDomainData(timeDataRef.current)

          let sum = 0
          for (let i = 0; i < timeDataRef.current.length; i++) {
            const centered = (timeDataRef.current[i] - 128) / 128
            sum += centered * centered
          }

          const rms = Math.sqrt(sum / timeDataRef.current.length)

          const rawEnergy = Math.min(1, Math.pow(rms * 7.5, 0.72))

          const energy =
            rawEnergy < NOISE_GATE
              ? 0
              : Math.min(1, (rawEnergy - NOISE_GATE) / (1 - NOISE_GATE))

          const isIdle = energy <= 0.001

          if (isIdle) {
            for (let i = 0; i < barCount; i++) {
              targetRef.current[i] = IDLE_BASE
            }
          } else {
            phaseRef.current += ACTIVE_PHASE_SPEED * energy

            const center = (barCount - 1) / 2

            for (let i = 0; i < barCount; i++) {
              const distanceFromCenter = Math.abs(i - center) / center
              const centerWeight = 1 - distanceFromCenter * 0.58

              const wave =
                0.5 +
                0.5 *
                Math.sin(
                  phaseRef.current +
                  i * 0.72 +
                  Math.sin(phaseRef.current * 0.6) * 0.35
                )

              const voiceMotion = energy * centerWeight * (0.52 + wave * 0.48)

              targetRef.current[i] = Math.max(
                IDLE_BASE,
                Math.min(1, IDLE_BASE + voiceMotion)
              )
            }
          }

          const next = displayRef.current.map((current, i) => {
            const target = targetRef.current[i]
            const velocity = target - current
            const easing = velocity > 0 ? ATTACK_EASING : RELEASE_EASING

            return current + velocity * easing
          })

          displayRef.current = next
          setBars(next)

          frameRef.current = requestAnimationFrame(tick)
        }

        frameRef.current = requestAnimationFrame(tick)
      } catch (e) {
        console.warn('Audio visualizer: mic access denied', e)
      }
    }

    setup()

    return () => {
      running = false
      cancelAnimationFrame(frameRef.current)

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
        streamRef.current = null
      }

      if (audioCtxRef.current) {
        audioCtxRef.current.close()
        audioCtxRef.current = null
      }

      analyserRef.current = null
    }
  }, [active, barCount])

  return bars
}

export default function App() {
  const [messages, setMessages] = useState<{ role: string, content: string }[]>([
    { role: 'assistant', content: 'I love using this AI companion. For my meetings and beyond.' }
  ])
  const [input, setInput] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('speech')

  const [voiceMode, setVoiceMode] = useState(false)
  const [speakText, setSpeakText] = useState(true)

  const [geminiKey, setGeminiKey] = useState('')
  const [cartesiaKey, setCartesiaKey] = useState('')
  const [sonioxKey, setSonioxKey] = useState('')
  const [inputDevice, setInputDevice] = useState<number | null>(null)
  const [outputDevice, setOutputDevice] = useState<number | null>(null)

  const [ttsVoice, setTtsVoice] = useState('79a125e8-cd45-4c13-8a67-188112f4dd22')
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
  const [observerProcessInterval, setObserverProcessInterval] = useState(300)
  const [debugMode, setDebugMode] = useState(false)

  // Dashboard & Navigation States
  const [activeTab, setActiveTab] = useState<'chat' | 'screen' | 'camera' | 'insights'>('chat')
  const [screenCaptures, setScreenCaptures] = useState<any[]>([])
  const [cameraSnapshots, setCameraSnapshots] = useState<any[]>([])
  const [geminiInsights, setGeminiInsights] = useState<any[]>([])
  const [lastRefresh, setLastRefresh] = useState(0)

  const audioBars = useAudioVisualizer(voiceMode, 5)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isConnectingRef = useRef(false)
  const isConnectedRef = useRef(false)
  const connectionIdRef = useRef(0)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshConversationsRef = useRef<() => void>(() => { })
  const skipDisconnectRef = useRef(false)

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
    if (backendStatus !== 'connected') return;
    fetch(`${API_URL}/api/settings`)
      .then(res => res.json())
      .then(data => {
        setGeminiKey(data.gemini_api_key || '')
        setCartesiaKey(data.cartesia_api_key || '')
        setSonioxKey(data.soniox_api_key || '')
        setInputDevice(data.input_device !== null ? data.input_device : null)
        setOutputDevice(data.output_device !== null ? data.output_device : null)
        setTtsVoice(data.tts_voice || '79a125e8-cd45-4c13-8a67-188112f4dd22')
        setTtsVolume(data.tts_volume ?? 1.0)
        setTtsSpeed(data.tts_speed ?? 1.0)
        setTtsEmotion(data.tts_emotion || 'neutral')
        setSttLanguage(data.stt_language || 'en')
        setSttProvider(data.stt_provider || 'soniox')
        setTtsLanguage(data.tts_language || 'en')

        // Load Observers settings
        const scrActive = data.observer_screen_active ?? false;
        const camActive = data.observer_camera_active ?? false;
        const capInt = data.observer_capture_interval ?? 60;
        const procInt = data.observer_process_interval ?? 300;

        setObserverScreenActive(scrActive);
        setObserverCameraActive(camActive);
        setObserverCaptureInterval(capInt);
        setObserverProcessInterval(procInt);
        setDebugMode(data.debug ?? false);

        updateObserverConfig({
          screenActive: scrActive,
          cameraActive: camActive,
          captureInterval: capInt
        });
      })
      .catch(console.error)
  }, [backendStatus])

  // Processor scheduling — frontend triggers the backend processor on interval
  useEffect(() => {
    if (!isElectron) return;
    if (backendStatus !== 'connected') return;
    if (!observerScreenActive && !observerCameraActive) return;

    const intervalMs = observerProcessInterval * 1000;
    const triggerProcessor = () => {
      fetch(`${API_URL}/api/processor/trigger`, { method: 'POST' })
        .catch(() => { });
    };

    triggerProcessor();
    const timer = setInterval(triggerProcessor, intervalMs);
    return () => clearInterval(timer);
  }, [backendStatus, observerProcessInterval, observerScreenActive, observerCameraActive]);

  useEffect(() => {
    if (backendStatus !== 'connected') return;
    fetch(`${API_URL}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_mode: voiceMode, speak_text: speakText })
    }).catch(console.error)
  }, [voiceMode, speakText, backendStatus])

  const handleDataChannelMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'start') {
        setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
      } else if (data.type === 'chunk') {
        setMessages(prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (lastIdx >= 0 && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = {
              ...newMsgs[lastIdx],
              content: newMsgs[lastIdx].content + data.text
            };
          } else {
            newMsgs.push({ role: 'assistant', content: data.text });
          }
          return newMsgs;
        });
      } else if (data.type === 'transcript') {
        setMessages(prev => [...prev, { role: 'user', content: data.text }]);
        refreshConversationsRef.current();
      } else if (data.type === 'end') {
        // response complete
      } else if (data.type === 'messages') {
        if (data.messages && data.messages.length > 0) {
          setMessages(data.messages);
        } else {
          setMessages([{ role: 'assistant', content: 'I love using this AI companion. For my meetings and beyond.' }]);
        }
      } else if (data.type === 'audio_level') {
        // locally captured via AudioContext analyser
      }
    } catch (e) {
      if (typeof event.data === 'string' && event.data === 'ping') {
        if (dcRef.current && dcRef.current.readyState === 'open') {
          dcRef.current.send('pong');
        }
      }
    }
  }, []);

  const disconnectWebRTC = useCallback(() => {
    isConnectingRef.current = false;
    isConnectedRef.current = false;
    connectionIdRef.current += 1;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }
  }, []);

  const connectWebRTC = useCallback(async () => {
    if (isConnectingRef.current || isConnectedRef.current) return;
    if (backendStatus !== 'connected') return;
    isConnectingRef.current = true;

    connectionIdRef.current += 1;
    const curId = connectionIdRef.current;

    let stream: MediaStream | null = null;
    let pc: RTCPeerConnection | null = null;

    try {
      // Get user microphone with echo cancellation
      const activeStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      stream = activeStream;

      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop());
        return;
      }
      localStreamRef.current = activeStream;

      const activePC = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      pc = activePC;
      pcRef.current = activePC;

      // Add mic track
      activeStream.getAudioTracks().forEach(track => activePC.addTrack(track, activeStream));

      // Create data channel for app messages (text chat, events)
      const dc = activePC.createDataChannel('chat', { ordered: true });
      dcRef.current = dc;
      dc.onmessage = handleDataChannelMessage;
      dc.onopen = () => {
        console.log('DataChannel open');
        if (dc.readyState === 'open') dc.send('ping');
        pingIntervalRef.current = setInterval(() => {
          if (dc.readyState === 'open') dc.send('ping');
        }, 1000);
      };
      dc.onclose = () => {
        console.log('DataChannel closed — scheduling reconnect...');
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
        if (curId === connectionIdRef.current && !reconnectTimeoutRef.current) {
          isConnectingRef.current = false;
          isConnectedRef.current = false;
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            if (curId === connectionIdRef.current) {
              console.log('Auto-reconnecting after DataChannel close...');
              disconnectWebRTC();
              connectWebRTC();
            }
          }, 1500);
        }
      };

      // Detect idle timeout / server-side teardown via ICE state
      activePC.oniceconnectionstatechange = () => {
        const state = activePC.iceConnectionState;
        console.log('ICE connection state:', state);
        if ((state === 'closed' || state === 'failed') && curId === connectionIdRef.current && !reconnectTimeoutRef.current) {
          console.log(`ICE ${state} — scheduling reconnect...`);
          isConnectingRef.current = false;
          isConnectedRef.current = false;
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            if (curId === connectionIdRef.current) {
              console.log('Auto-reconnecting after ICE state change...');
              disconnectWebRTC();
              connectWebRTC();
            }
          }, 1500);
        }
      };

      // Handle incoming audio from bot
      activePC.ontrack = (event) => {
        console.log('Received remote track', event.track.kind);
        if (event.track.kind === 'audio') {
          const audio = new Audio();
          audio.srcObject = new MediaStream([event.track]);
          audio.autoplay = true;
          audioRef.current = audio;
        }
      };

      // Create SDP offer
      const offer = await activePC.createOffer();
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop());
        activePC.close();
        return;
      }
      await activePC.setLocalDescription(offer);
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop());
        activePC.close();
        return;
      }

      // Wait for ICE gathering to complete
      await new Promise<void>((resolve) => {
        if (activePC.iceGatheringState === 'complete') {
          resolve();
        } else {
          const checkState = () => {
            if (activePC.iceGatheringState === 'complete') {
              activePC.removeEventListener('icegatheringstatechange', checkState);
              resolve();
            }
          };
          activePC.addEventListener('icegatheringstatechange', checkState);
          // Timeout fallback
          setTimeout(resolve, 3000);
        }
      });
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop());
        activePC.close();
        return;
      }

      // Send offer to backend
      const response = await fetch(`${API_URL}/api/webrtc/connect?conversation_id=${activeConversationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: activePC.localDescription!.sdp,
          type: activePC.localDescription!.type
        })
      });
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop());
        activePC.close();
        return;
      }
      const answer = await response.json();
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop());
        activePC.close();
        return;
      }

      await activePC.setRemoteDescription(new RTCSessionDescription({
        sdp: answer.sdp,
        type: answer.type
      }));
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop());
        activePC.close();
        return;
      }

      isConnectingRef.current = false;
      isConnectedRef.current = true;
      console.log('WebRTC connected, pc_id:', answer.pc_id);
    } catch (e) {
      console.error('WebRTC connection failed:', e);
      if (curId === connectionIdRef.current) {
        disconnectWebRTC();
      } else {
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (pc) pc.close();
      }
    }
  }, [handleDataChannelMessage, disconnectWebRTC, backendStatus, activeConversationId]);

  const refreshConversations = useCallback(() => {
    fetch(`${API_URL}/api/conversations`)
      .then(res => res.json())
      .then(data => setConversations(data || []))
      .catch(() => { });
  }, []);
  refreshConversationsRef.current = refreshConversations;

  // Load conversations list
  useEffect(() => {
    if (backendStatus !== 'connected') return;
    fetch(`${API_URL}/api/conversations`)
      .then(res => res.json())
      .then(data => {
        setConversations(data || []);
        if (data && data.length > 0 && !activeConversationId) {
          loadConversation(data[0].id);
        } else if ((!data || data.length === 0) && !activeConversationId) {
          createNewConversation();
        }
      })
      .catch(console.error);
  }, [backendStatus]);

  const loadConversation = async (id: string) => {
    try {
      // Reuse existing pipeline if connected
      if (dcRef.current && dcRef.current.readyState === 'open') {
        skipDisconnectRef.current = true;
        setActiveConversationId(id);
        dcRef.current.send(JSON.stringify({ type: 'switch_conversation', conversation_id: id }));
        return;
      }
      if (pcRef.current) disconnectWebRTC();
      setActiveConversationId(id);

      const res = await fetch(`${API_URL}/api/conversations/${id}/messages`);
      const data = await res.json();
      if (data && data.length > 0) {
        setMessages(data);
      } else {
        setMessages([
          { role: 'assistant', content: 'I love using this AI companion. For my meetings and beyond.' }
        ]);
      }
    } catch (e) {
      console.error("Failed to load conversation messages");
    }
  };

  const createNewConversation = async () => {
    try {
      const res = await fetch(`${API_URL}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      setConversations(prev => [data, ...prev]);
      if (dcRef.current && dcRef.current.readyState === 'open') {
        skipDisconnectRef.current = true;
        setActiveConversationId(data.id);
        dcRef.current.send(JSON.stringify({ type: 'switch_conversation', conversation_id: data.id }));
      } else {
        setActiveConversationId(data.id);
      }
      setMessages([
        { role: 'assistant', content: 'I love using this AI companion. For my meetings and beyond.' }
      ]);
    } catch (e) {
      console.error("Failed to create new conversation");
    }
  };

  const deleteConversation = async (id: string) => {
    try {
      await fetch(`${API_URL}/api/conversations/${id}`, {
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

  // Connect WebRTC on mount/status change/active conversation change
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (backendStatus === 'connected' && activeConversationId) {
      timer = setTimeout(() => connectWebRTC(), 100);
    }
    return () => {
      if (timer) clearTimeout(timer);
      if (!skipDisconnectRef.current) disconnectWebRTC();
      skipDisconnectRef.current = false;
    };
  }, [connectWebRTC, disconnectWebRTC, backendStatus, activeConversationId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages])

  const saveSettings = async () => {
    try {
      await fetch(`${API_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gemini_api_key: geminiKey,
          cartesia_api_key: cartesiaKey,
          soniox_api_key: sonioxKey,
          input_device: inputDevice,
          output_device: outputDevice,
          tts_voice: ttsVoice,
          tts_volume: ttsVolume,
          tts_speed: ttsSpeed,
          tts_emotion: ttsEmotion,
          stt_language: sttLanguage,
          tts_language: ttsLanguage,
          stt_provider: sttProvider,
          observer_screen_active: observerScreenActive,
          observer_camera_active: observerCameraActive,
          observer_capture_interval: observerCaptureInterval,
          observer_process_interval: observerProcessInterval
        })
      })
      updateObserverConfig({
        screenActive: observerScreenActive,
        cameraActive: observerCameraActive,
        captureInterval: observerCaptureInterval
      })
      setIsSettingsOpen(false)
    } catch (e) {
      console.error("Failed to save settings")
    }
  }

  const fetchObservations = useCallback(async (tab: string, forceRefresh = false) => {
    try {
      const now = Date.now();
      if (tab === 'screen') {
        const res = await fetch(`${API_URL}/api/observations?type=screen&limit=15&_=${now}`);
        if (res.ok) {
          const data = await res.json();
          setScreenCaptures(data || []);
          if (forceRefresh) setLastRefresh(now);
        }
      } else if (tab === 'camera') {
        const res = await fetch(`${API_URL}/api/observations?type=camera&limit=15&_=${now}`);
        if (res.ok) {
          const data = await res.json();
          setCameraSnapshots(data || []);
          if (forceRefresh) setLastRefresh(now);
        }
      } else if (tab === 'insights') {
        const res = await fetch(`${API_URL}/api/insights?limit=15&_=${now}`);
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

  const sendMessage = () => {
    if (!input.trim()) return
    setMessages(prev => [...prev, { role: 'user', content: input }])
    const currentInput = input
    setInput('')

    // Send via DataChannel
    if (dcRef.current && dcRef.current.readyState === 'open') {
      dcRef.current.send(JSON.stringify({ type: 'chat', text: currentInput }));
    } else {
      console.warn('DataChannel not open, cannot send message');
    }
  }

  return (
    <div className="h-screen w-full bg-white flex overflow-hidden font-sans relative">

      {/* Sidebar */}
      <div className="w-64 border-r border-slate-100 bg-[#fafafa] hidden lg:flex flex-col pt-12 pb-4">
        <div className="px-5 mb-8 flex items-center gap-3">
          <img src="./logo.jpg" alt="Molly Logo" className="w-12 h-12 rounded-full object-cover border border-slate-100 shadow-sm" />
          <span className="font-semibold text-slate-800 text-sm tracking-wide">Molly</span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-0.5">
          <button onClick={createNewConversation} className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
            <PenSquare className="w-3.5 h-3.5" /> New Chat
          </button>
          <button className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
            <Search className="w-3.5 h-3.5" /> Search
          </button>
          <button className="w-full flex items-center justify-between px-3 py-1 text-sm font-medium text-slate-800 bg-[#eef2fc] rounded-md transition-colors">
            <div className="flex items-center gap-2"><FileText className="w-3.5 h-3.5 text-blue-600" /> Active Context</div>
            <span className="text-[9px] uppercase tracking-wider bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded">Beta</span>
          </button>
          <button className="w-full flex items-center gap-2 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
            <Clock className="w-3.5 h-3.5" /> Routines
          </button>

          <div className="pt-6 pb-2 px-3 text-[10px] uppercase font-semibold tracking-wider text-slate-400">Conversations</div>
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
                  onClick={() => loadConversation(conv.id)}
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



        <div className="px-4 mt-auto">
          <button onClick={() => setIsSettingsOpen(true)} className="w-full flex items-center gap-2 px-2 py-2 text-xs border border-slate-200 rounded-md shadow-sm text-slate-600 hover:bg-slate-50 transition-colors">
            <div className="w-5 h-5 rounded bg-slate-200 flex items-center justify-center text-slate-600 font-medium">U</div>
            <div className="flex flex-col items-start flex-1 text-[10px]">
              <span className="font-semibold leading-tight">Settings</span>
              <span className="text-slate-400 leading-tight">API Config</span>
            </div>
            <Settings className="w-3.5 h-3.5 opacity-50" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 bg-white flex flex-col pt-12 relative">
        {/* Header */}
        <div className="px-8 pb-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-100 flex-shrink-0">
          <div className="flex flex-col lg:flex-row lg:items-center gap-6 w-full lg:w-auto">
            <div className="flex gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/40 backdrop-blur-sm shadow-inner self-center">
              {(['chat', 'screen', 'camera', 'insights'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`text-xs font-semibold px-4 py-1.5 rounded-lg transition-all uppercase tracking-wider text-[10px] ${activeTab === tab
                    ? 'bg-slate-900 text-white shadow-md'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200/50'
                    }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap self-center lg:self-auto">
            {activeTab === 'chat' && (
              <>
                <button
                  onClick={() => setSpeakText(!speakText)}
                  className={`flex items-center gap-1.5 text-xs font-medium transition-all px-3 py-1.5 rounded-lg border ${speakText
                    ? 'bg-indigo-50 text-indigo-600 border-indigo-100 shadow-sm'
                    : 'bg-slate-50 text-slate-500 border-slate-200'
                    }`}
                >
                  {speakText ? <Volume2 className="w-3.5 h-3.5 text-indigo-500" /> : <VolumeX className="w-3.5 h-3.5" />}
                  {speakText ? "AI Speaking" : "AI Muted"}
                </button>

                <button
                  onClick={() => setMessages([])}
                  className="border border-slate-200 px-3.5 py-1.5 rounded-lg shadow-sm hover:bg-slate-50 transition-colors text-xs font-medium text-slate-500"
                >
                  Clear Chat
                </button>
              </>
            )}
          </div>
        </div>

        {/* Chat Tab - original styling preserved */}
        <div className={`flex-1 overflow-y-auto px-4 md:px-8 py-4 ${activeTab === 'chat' ? '' : 'hidden'}`} ref={scrollRef}>
          <div className="flex flex-col gap-5 max-w-3xl mx-auto w-full">
            {messages.map((m, i) => (
              <div key={i} className={`flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`px-4 py-2.5 ${m.role === 'user' ? 'lux-bubble-user' : 'lux-bubble-ai'}`}>
                  {m.content}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Observer Tabs Viewport */}
        <div className={`flex-1 overflow-y-auto px-6 md:px-10 py-6 bg-slate-50/40 ${activeTab !== 'chat' ? '' : 'hidden'}`}>

          <div className={`${activeTab === 'screen' ? '' : 'hidden'}`}>
            <div className="max-w-6xl mx-auto w-full animate-in fade-in duration-300">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Desktop Capture History</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">Automated timestamped screenshots of your workspace to provide Molly with workspace context.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => fetchObservations('screen', true)}
                    className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3 h-3" /> Refresh
                  </button>
                </div>
              </div>

              {screenCaptures.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[350px] border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm">
                  <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
                    <Clock className="w-6 h-6 text-slate-400" />
                  </div>
                  <span className="text-slate-600 font-medium text-sm">No Desktop captures logged yet.</span>
                  <span className="text-[11px] text-slate-400 mt-1 max-w-xs text-center leading-normal">
                    Enable the Screen Capture toggle in the settings menu to initiate the automated background observation system.
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {screenCaptures.map(cap => (
                    <div key={cap.id} className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm bg-white hover:shadow-md transition-all hover:scale-[1.01] duration-300 group">
                      <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
                        <img
                          src={`${API_URL}/static/${cap.image_path}?t=${lastRefresh}`}
                          alt="Desktop Capture"
                          loading="lazy"
                          className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-500"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                          <span className="text-[10px] font-mono text-white/90">ID: #{cap.id}</span>
                        </div>
                      </div>
                      <div className="p-4 bg-white">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">Screen Source</span>
                          <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${cap.processed
                            ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                            : 'bg-amber-50 text-amber-600 border border-amber-100'
                            }`}>
                            {cap.processed ? 'Processed' : 'Pending Analysis'}
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
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Camera Snapshot History</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">Continuous visual recordings of webcam environment snapshots.</p>
                </div>
                <button
                  onClick={() => fetchObservations('camera', true)}
                  className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>

              {cameraSnapshots.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[350px] border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm">
                  <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
                    <Clock className="w-6 h-6 text-slate-400" />
                  </div>
                  <span className="text-slate-600 font-medium text-sm">No Camera snaps logged yet.</span>
                  <span className="text-[11px] text-slate-400 mt-1 max-w-xs text-center leading-normal">
                    Enable the Camera Snaps toggle in the settings menu to initiate the automated background capture loops.
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {cameraSnapshots.map(cap => (
                    <div key={cap.id} className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm bg-white hover:shadow-md transition-all hover:scale-[1.01] duration-300 group">
                      <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
                        <img
                          src={`${API_URL}/static/${cap.image_path}?t=${lastRefresh}`}
                          alt="Camera Snapshot"
                          loading="lazy"
                          className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-500"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                          <span className="text-[10px] font-mono text-white/90">ID: #{cap.id}</span>
                        </div>
                      </div>
                      <div className="p-4 bg-white">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">Camera Snaps</span>
                          <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${cap.processed
                            ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                            : 'bg-amber-50 text-amber-600 border border-amber-100'
                            }`}>
                            {cap.processed ? 'Processed' : 'Pending Analysis'}
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
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Gemini Context Timeline</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">Proactive activity logs, application usage audits, and lifestyle tips generated by Gemini.</p>
                </div>
                <button
                  onClick={() => fetchObservations('insights', true)}
                  className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>

              {geminiInsights.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[350px] border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm">
                  <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
                    <Bird className="w-6 h-6 text-slate-400" />
                  </div>
                  <span className="text-slate-600 font-medium text-sm">No Gemini Insights compiled yet.</span>
                  <span className="text-[11px] text-slate-400 mt-1 max-w-xs text-center leading-normal">
                    Molly will periodically process pending screen captures in the background to log reports and provide tips.
                  </span>
                </div>
              ) : (
                <div className="relative border-l-2 border-slate-200/80 ml-4 pl-8 space-y-8 py-2">
                  {geminiInsights.map(ins => (
                    <div key={ins.id} className="relative bg-white rounded-2xl border border-slate-100 p-6 shadow-sm hover:shadow-md transition-all duration-300">
                      {/* Timeline Dot Indicator */}
                      <div className="absolute w-4 h-4 bg-slate-900 rounded-full -left-[41px] top-6 border-4 border-slate-50 flex items-center justify-center shadow-sm" />

                      <div className="flex flex-wrap justify-between items-center gap-2 pb-3 border-b border-slate-50">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider bg-slate-900 text-white px-2.5 py-0.5 rounded-md">
                          Molly Report #{ins.id}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {new Date(ins.timestamp).toLocaleString()}
                        </span>
                      </div>

                      <div className="mt-4">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Activity Summary</span>
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
                            <span className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-wider block">Molly's Suggestion</span>
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
        <div className={`p-6 bg-gradient-to-t from-white via-white to-transparent flex-shrink-0 border-t border-slate-50 ${activeTab === 'chat' ? '' : 'hidden'}`}>
          <div className="max-w-2xl mx-auto flex items-center gap-2 bg-[#f9f9f9] border border-slate-200 rounded-full px-4 py-1.5 shadow-sm focus-within:ring-1 focus-within:ring-slate-350 transition-all">
            <div className="text-slate-400 flex items-center justify-center">
              <span className="text-lg leading-none mb-1 opacity-60">...</span>
            </div>
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMessage()}
              className="flex-1 bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0 px-2 text-slate-700 text-sm shadow-none"
              placeholder="Ask Molly about your context..."
              disabled={voiceMode}
            />
            <button
              onClick={() => setVoiceMode(!voiceMode)}
              className={`flex items-center justify-center transition-all border ${voiceMode
                ? 'px-3 py-1.5 rounded-full bg-rose-50 border-rose-200 shadow-sm gap-2 ring-1 ring-rose-100'
                : 'w-8 h-8 rounded-full bg-slate-50 text-slate-500 hover:text-slate-800 border-slate-200 hover:bg-slate-100'
                }`}
              title={voiceMode ? "Turn Off Voice Mode" : "Turn On Voice Mode"}
            >
              {voiceMode ? (
                <>
                  <Mic className="w-3.5 h-3.5 text-rose-500" />
                  <div className="flex items-center gap-[3px] h-5 px-1">
                    {audioBars.map((level, i) => (
                      <span
                        key={i}
                        className="w-[3px] rounded-full bg-rose-500/90 shadow-[0_0_8px_rgba(244,63,94,0.28)] transition-[height,opacity,transform] duration-100 ease-out"
                        style={{
                          height: `${5 + level * 18}px`,
                          opacity: 0.42 + level * 0.58,
                          transform: `scaleY(${0.92 + level * 0.12})`
                        }}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <Mic className="w-3.5 h-3.5 text-slate-500" />
              )}
            </button>

            <button
              onClick={sendMessage}
              disabled={voiceMode || !input.trim()}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 px-3.5 py-1.5 rounded-full shadow-sm hover:bg-slate-50 transition-all disabled:opacity-50"
            >
              <div className="w-2 h-2 bg-slate-900 rounded-sm"></div>
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/10 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-2xl bg-white rounded-xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 animate-in zoom-in-95 flex flex-col h-[500px]">
            <div className="p-5 border-b border-slate-100 flex-shrink-0">
              <h2 className="font-serif text-xl text-slate-900 tracking-tight">Configuration</h2>
              <p className="text-xs text-slate-500 mt-1">Manage your API keys and local inference.</p>
            </div>

            <div className="flex flex-1 overflow-hidden">
              {/* Tabs Sidebar */}
              <div className="w-48 bg-slate-50 border-r border-slate-100 p-3 flex flex-col gap-1 overflow-y-auto">
                <button onClick={() => setSettingsTab('speech')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${settingsTab === 'speech' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>Speech</button>
                <button onClick={() => setSettingsTab('api')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${settingsTab === 'api' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>API Config</button>
                {isElectron && (
                  <button onClick={() => setSettingsTab('observers')} className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${settingsTab === 'observers' ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-slate-100'}`}>Observers</button>
                )}
              </div>

              {/* Tab Content */}
              <div className="flex-1 p-6 overflow-y-auto">
                {settingsTab === 'api' && (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">Gemini API Key</label>
                      <Input type="password" value={geminiKey} onChange={e => setGeminiKey(e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder="AIzaSy..." />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">Cartesia API Key (TTS)</label>
                      <Input type="password" value={cartesiaKey} onChange={e => setCartesiaKey(e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder="sk-..." />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">Soniox API Key (STT)</label>
                      <Input type="password" value={sonioxKey} onChange={e => setSonioxKey(e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder="soniox-..." />
                    </div>
                  </div>
                )}

                {/* Audio Devices tab removed - browser handles device selection via getUserMedia */}

                {settingsTab === 'speech' && (
                  <div className="flex flex-col gap-4">

                    {/* TTS Section */}
                    <div className="pt-1 pb-2 border-b border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Speech Output (TTS)</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">Voice ID</label>
                      <Input value={ttsVoice} onChange={e => setTtsVoice(e.target.value)} className="bg-[#f9f9f9] border-slate-200 text-sm focus-visible:ring-slate-300" placeholder="79a125e8-..." />
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex-1 flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-slate-700 flex justify-between">Volume <span>{ttsVolume}</span></label>
                        <input type="range" min="0.5" max="2.0" step="0.1" value={ttsVolume} onChange={e => setTtsVolume(parseFloat(e.target.value))} className="w-full accent-slate-900" />
                      </div>
                      <div className="flex-1 flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-slate-700 flex justify-between">Speed <span>{ttsSpeed}</span></label>
                        <input type="range" min="0.6" max="1.5" step="0.1" value={ttsSpeed} onChange={e => setTtsSpeed(parseFloat(e.target.value))} className="w-full accent-slate-900" />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">Emotion</label>
                      <select value={ttsEmotion} onChange={e => setTtsEmotion(e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                        {['calm', 'happy', 'excited', 'enthusiastic', 'curious', 'content', 'peaceful', 'serene', 'grateful', 'affectionate', 'flirtatious', 'sarcastic', 'sad', 'wistful', 'apologetic', 'confident', 'neutral'].map(emotion => (
                          <option key={emotion} value={emotion}>{emotion.charAt(0).toUpperCase() + emotion.slice(1)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">TTS Language</label>
                      <select value={ttsLanguage} onChange={e => setTtsLanguage(e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                        {[
                          { code: 'en', label: 'English' }, { code: 'zh', label: 'Chinese' }, { code: 'ja', label: 'Japanese' },
                          { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
                          { code: 'pt', label: 'Portuguese' }, { code: 'it', label: 'Italian' }
                        ].map(lang => (
                          <option key={lang.code} value={lang.code}>{lang.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* STT Section */}
                    <div className="pt-4 pb-2 border-b border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Speech Input (STT)</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">Provider</label>
                      <select value={sttProvider} onChange={e => setSttProvider(e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
                        <option value="soniox">Soniox (Recommended)</option>
                        <option value="cartesia">Cartesia</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-slate-700">Transcription Language</label>
                      <select value={sttLanguage} onChange={e => setSttLanguage(e.target.value)} className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-300 rounded-md h-9 px-3 outline-none">
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

                {settingsTab === 'observers' && (
                  <div className="flex flex-col gap-4 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-slate-800">Screen Capture Observer</span>
                        <span className="text-[10px] text-slate-400 mt-0.5 font-medium">Periodically capture your active workspace</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={observerScreenActive}
                        onChange={e => setObserverScreenActive(e.target.checked)}
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
                        checked={observerCameraActive}
                        onChange={e => setObserverCameraActive(e.target.checked)}
                        className="w-4.5 h-4.5 accent-slate-900 cursor-pointer rounded"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5 pt-2">
                      <label className="text-xs font-semibold text-slate-700 flex justify-between">
                        Capture Interval <span>{observerCaptureInterval}s</span>
                      </label>
                      <select
                        value={observerCaptureInterval}
                        onChange={e => setObserverCaptureInterval(parseInt(e.target.value))}
                        className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none"
                      >
                        <option value={30}>30 Seconds</option>
                        <option value={60}>1 Minute (Default)</option>
                        <option value={120}>2 Minutes</option>
                        <option value={300}>5 Minutes</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-semibold text-slate-700 flex justify-between">
                        Gemini Processing Interval <span>{observerProcessInterval / 60}m</span>
                      </label>
                      <select
                        value={observerProcessInterval}
                        onChange={e => setObserverProcessInterval(parseInt(e.target.value))}
                        className="bg-[#f9f9f9] border border-slate-200 text-sm focus-visible:ring-slate-350 rounded-lg h-9.5 px-3 outline-none"
                      >
                        <option value={120}>2 Minutes</option>
                        <option value={300}>5 Minutes (Default)</option>
                        <option value={600}>10 Minutes</option>
                        <option value={900}>15 Minutes</option>
                      </select>
                    </div>

                    {debugMode && (
                      <div className="flex flex-col gap-2 pt-4 border-t border-amber-200 mt-2">
                        <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" /> Debug Actions
                        </span>
                        <div className="flex gap-2">
                          <button
                            onClick={async () => { await triggerObservationsCapture(); fetchObservations('screen', true); }}
                            className="text-[10px] font-semibold text-amber-700 hover:text-amber-900 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg transition-all"
                          >
                            Capture Now
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await fetch('${API_URL}/api/processor/trigger', { method: 'POST' });
                                fetchObservations('insights', true);
                              } catch (e) { console.error('Processor trigger failed:', e); }
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

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-1.5 px-3 py-1 bg-white border border-slate-250 rounded-full shadow-sm">
                <span className={`w-2 h-2 rounded-full ${backendStatus === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' :
                  backendStatus === 'disconnected' ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]' :
                    'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]'
                  }`} />
                <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                  Server Status: {backendStatus === 'connected' ? 'Online' :
                    backendStatus === 'disconnected' ? 'Offline' :
                      'Checking'}
                </span>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setIsSettingsOpen(false)} className="rounded-md text-xs h-8 text-slate-600 hover:bg-slate-200/50">Cancel</Button>
                <Button onClick={saveSettings} className="bg-slate-900 hover:bg-slate-800 text-white rounded-md text-xs h-8 px-4 shadow-sm">Save Changes</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
