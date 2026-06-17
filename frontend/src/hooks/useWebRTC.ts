import { useCallback, useRef, useEffect, useState } from 'react'
import i18n from '../i18n/config'
import { API_URL, getStoredToken, refreshAccessToken } from '../config'

interface UseWebRTCOptions {
  backendStatus: string
  activeConversationId: string
  setMessages: React.Dispatch<React.SetStateAction<{ role: string; content: string }[]>>
  refreshConversationsRef: React.MutableRefObject<() => void>
  onThinking?: (action: string, detail: string) => void
  onThinkingDone?: () => void
}

interface UseWebRTCReturn {
  dcRef: React.MutableRefObject<RTCDataChannel | null>
  pcRef: React.MutableRefObject<RTCPeerConnection | null>
  isConnectedRef: React.MutableRefObject<boolean>
  pipelineReady: boolean
  disconnectWebRTC: () => void
  connectWebRTC: () => Promise<void>
  sendChatMessage: (text: string) => void
  sendSessionState: (changes: Record<string, unknown>) => void
}

export default function useWebRTC(opts: UseWebRTCOptions): UseWebRTCReturn {
  const optsRef = useRef(opts)
  optsRef.current = opts

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isConnectingRef = useRef(false)
  const isConnectedRef = useRef(false)
  const connectionIdRef = useRef(0)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipDisconnectRef = useRef(false)
  const messageQueueRef = useRef<string[]>([])
  const [pipelineReady, setPipelineReady] = useState(false)

  const handleDataChannelMessage = useCallback((event: MessageEvent) => {
    const { setMessages, refreshConversationsRef: refConvRef } = optsRef.current
    try {
      const data = JSON.parse(event.data)
      if (data.type === 'start') {
        setMessages(prev => [...prev, { role: 'assistant', content: '' }])
      } else if (data.type === 'chunk') {
        setMessages(prev => {
          const newMsgs = [...prev]
          const lastIdx = newMsgs.length - 1
          if (lastIdx >= 0 && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = {
              ...newMsgs[lastIdx],
              content: newMsgs[lastIdx].content + data.text
            }
          } else {
            newMsgs.push({ role: 'assistant', content: data.text })
          }
          return newMsgs
        })
      } else if (data.type === 'transcript') {
        setMessages(prev => [...prev, { role: 'user', content: data.text }])
        refConvRef.current()
      } else if (data.type === 'end') {
        // response complete
      } else if (data.type === 'messages') {
        if (data.messages && data.messages.length > 0) {
          setMessages(prev => prev.length > 0 ? prev : data.messages)
        } else {
          setMessages([{ role: 'assistant', content: i18n.t('app.helloDefault') }])
        }
      } else if (data.type === 'audio_level') {
        // locally captured via AudioContext analyser
      } else if (data.type === 'thinking') {
        optsRef.current.onThinking?.(data.action, data.detail)
      } else if (data.type === 'thinking_done') {
        optsRef.current.onThinkingDone?.()
      }
    } catch {
      if (typeof event.data === 'string' && event.data === 'ping') {
        if (dcRef.current && dcRef.current.readyState === 'open') {
          dcRef.current.send('pong')
        }
      }
    }
  }, [])

  const disconnectWebRTC = useCallback(() => {
    skipDisconnectRef.current = true
    isConnectingRef.current = false
    isConnectedRef.current = false
    setPipelineReady(false)
    messageQueueRef.current = []
    connectionIdRef.current += 1
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = null
    }
    if (dcRef.current) {
      dcRef.current.close()
      dcRef.current = null
    }
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
    }
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.srcObject = null
      audioRef.current = null
    }
  }, [])

  const connectWebRTC = useCallback(async () => {
    const { backendStatus, activeConversationId } = optsRef.current
    if (isConnectingRef.current || isConnectedRef.current) return
    if (backendStatus !== 'connected') return
    isConnectingRef.current = true

    connectionIdRef.current += 1
    const curId = connectionIdRef.current

    let stream: MediaStream | null = null
    let pc: RTCPeerConnection | null = null

    try {
      const activeStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      stream = activeStream

      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop())
        return
      }
      localStreamRef.current = activeStream

      const activePC = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      })
      pc = activePC
      pcRef.current = activePC

      activeStream.getAudioTracks().forEach(track => activePC.addTrack(track, activeStream))

      const dc = activePC.createDataChannel('chat', { ordered: true })
      dcRef.current = dc
      dc.onmessage = handleDataChannelMessage
      dc.onopen = () => {
        console.log('DataChannel open')
        setPipelineReady(true)
        if (dc.readyState === 'open') dc.send('ping')
        pingIntervalRef.current = setInterval(() => {
          if (dc.readyState === 'open') dc.send('ping')
        }, 1000)
        if (messageQueueRef.current.length > 0) {
          console.log('Flushing', messageQueueRef.current.length, 'queued messages')
          for (const msg of messageQueueRef.current) {
            dc.send(msg)
          }
          messageQueueRef.current = []
        }
      }
      dc.onclose = () => {
        console.log('DataChannel closed — scheduling reconnect...')
        setPipelineReady(false)
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)
        if (curId === connectionIdRef.current && !reconnectTimeoutRef.current) {
          isConnectingRef.current = false
          isConnectedRef.current = false
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null
            if (curId === connectionIdRef.current) {
              console.log('Auto-reconnecting after DataChannel close...')
              disconnectWebRTC()
              connectWebRTC()
            }
          }, 1500)
        }
      }

      activePC.oniceconnectionstatechange = () => {
        const state = activePC.iceConnectionState
        console.log('ICE connection state:', state)
        if ((state === 'closed' || state === 'failed') && curId === connectionIdRef.current && !reconnectTimeoutRef.current) {
          console.log(`ICE ${state} — scheduling reconnect...`)
          setPipelineReady(false)
          isConnectingRef.current = false
          isConnectedRef.current = false
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null
            if (curId === connectionIdRef.current) {
              console.log('Auto-reconnecting after ICE state change...')
              disconnectWebRTC()
              connectWebRTC()
            }
          }, 1500)
        }
      }

      activePC.ontrack = (event) => {
        console.log('Received remote track', event.track.kind)
        if (event.track.kind === 'audio') {
          const audio = new Audio()
          audio.srcObject = new MediaStream([event.track])
          audio.autoplay = true
          audioRef.current = audio
        }
      }

      const offer = await activePC.createOffer()
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop())
        activePC.close()
        return
      }
      await activePC.setLocalDescription(offer)
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop())
        activePC.close()
        return
      }

      await new Promise<void>((resolve) => {
        if (activePC.iceGatheringState === 'complete') {
          resolve()
        } else {
          const checkState = () => {
            if (activePC.iceGatheringState === 'complete') {
              activePC.removeEventListener('icegatheringstatechange', checkState)
              resolve()
            }
          }
          activePC.addEventListener('icegatheringstatechange', checkState)
          setTimeout(resolve, 3000)
        }
      })
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop())
        activePC.close()
        return
      }

      let token = getStoredToken()
      const makeTokenParam = (t: string | null) => t ? `&token=${encodeURIComponent(t)}` : ''
      const doFetch = (t: string | null) =>
        fetch(`${API_URL}/api/webrtc/connect?conversation_id=${activeConversationId}${makeTokenParam(t)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sdp: activePC.localDescription!.sdp,
            type: activePC.localDescription!.type
          })
        })
      let response = await doFetch(token)
      if (response.status === 401) {
        const newToken = await refreshAccessToken()
        if (newToken) {
          token = newToken
          response = await doFetch(token)
        }
      }
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop())
        activePC.close()
        return
      }
      const answer = await response.json()
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop())
        activePC.close()
        return
      }

      await activePC.setRemoteDescription(new RTCSessionDescription({
        sdp: answer.sdp,
        type: answer.type
      }))
      if (curId !== connectionIdRef.current) {
        activeStream.getTracks().forEach(t => t.stop())
        activePC.close()
        return
      }

      isConnectingRef.current = false
      isConnectedRef.current = true
      console.log('WebRTC connected, pc_id:', answer.pc_id)
    } catch (e) {
      console.error('WebRTC connection failed:', e)
      if (curId === connectionIdRef.current) {
        disconnectWebRTC()
      } else {
        if (stream) stream.getTracks().forEach(t => t.stop())
        if (pc) pc.close()
      }
    }
  }, [handleDataChannelMessage, disconnectWebRTC])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    if (opts.backendStatus === 'connected' && opts.activeConversationId) {
      timer = setTimeout(() => connectWebRTC(), 100)
    }
    return () => {
      if (timer) clearTimeout(timer)
      if (!skipDisconnectRef.current) disconnectWebRTC()
      skipDisconnectRef.current = false
    }
  }, [opts.backendStatus, opts.activeConversationId, connectWebRTC, disconnectWebRTC])

  const sendChatMessage = useCallback((text: string) => {
    const payload = JSON.stringify({ type: 'chat', text })
    if (dcRef.current && dcRef.current.readyState === 'open') {
      dcRef.current.send(payload)
    } else {
      console.log('DataChannel not open — queuing message')
      messageQueueRef.current.push(payload)
    }
  }, [])

  const sendSessionState = useCallback((changes: Record<string, unknown>) => {
    const payload = JSON.stringify({ type: 'session_state_updated', changes })
    if (dcRef.current && dcRef.current.readyState === 'open') {
      dcRef.current.send(payload)
    } else {
      console.log('DataChannel not open — queuing session_state_updated')
      messageQueueRef.current.push(payload)
    }
  }, [])

  return {
    dcRef,
    pcRef,
    isConnectedRef,
    pipelineReady,
    disconnectWebRTC,
    connectWebRTC,
    sendChatMessage,
    sendSessionState,
  }
}
