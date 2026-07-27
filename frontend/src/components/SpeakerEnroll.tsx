import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic, Square, Trash2, Loader2, Check } from 'lucide-react'
import { API_URL } from '../config'
import { useAuth } from '../contexts/AuthContext'

interface Props {
  /** Whether the gate is switched on. Off by default. */
  enabled: boolean
  onEnabledChange: (v: boolean) => void
  /** Whether a voice is already on file. */
  enrolled: boolean
  threshold: number
  onThresholdChange: (v: number) => void
  onEnrolledChange: (v: boolean) => void
}

const TARGET_RATE = 16000
const RECORD_SECONDS = 15

/** Encode mono float samples as a 16-bit PCM WAV.
 *
 *  MediaRecorder produces webm/opus, which libsndfile on the backend cannot
 *  read. Decoding here and sending a plain WAV keeps the backend to one audio
 *  path instead of pulling in a transcoder for a fifteen second clip. */
function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buf)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  str(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/** Teaches the backend what the user sounds like, so live mode can ignore
 *  everything that isn't them — a television, a flatmate, a podcast. */
export default function SpeakerEnroll({
  enabled, onEnabledChange, enrolled, threshold, onThresholdChange, onEnrolledChange,
}: Props) {
  const { t } = useTranslation()
  const auth = useAuth()

  const [recording, setRecording] = useState(false)
  const [left, setLeft] = useState(RECORD_SECONDS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const recorderRef = useRef<MediaRecorder | null>(null)
  const timerRef = useRef<number | null>(null)

  // A recorder still holding the microphone after the panel closes would leave
  // the OS mic indicator on with nothing listening.
  useEffect(() => () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    if (timerRef.current) window.clearInterval(timerRef.current)
  }, [])

  const upload = async (blob: Blob) => {
    setBusy(true); setError(''); setDone('')
    const body = new FormData()
    body.append('sample', blob, 'enroll.wav')
    try {
      const res = await auth.authFetch(`${API_URL}/api/speaker/enroll`,
        { method: 'POST', body })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data?.detail === 'string' ? data.detail : 'failed')
        return
      }
      onEnrolledChange(true)
      setDone(t('settings.speakerEnrolledFrom', { seconds: data.seconds }))
    } catch { setError('network') }
    finally { setBusy(false) }
  }

  const stop = () => {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    setRecording(false)
  }

  const record = async () => {
    setError(''); setDone('')
    let stream: MediaStream
    try {
      // No noise suppression or AGC here: they reshape the voice, and the
      // template should match how the microphone actually hears the person.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      })
    } catch { setError('mic_denied'); return }

    const chunks: Blob[] = []
    const rec = new MediaRecorder(stream)
    recorderRef.current = rec
    rec.ondataavailable = e => e.data.size && chunks.push(e.data)
    rec.onstop = async () => {
      stream.getTracks().forEach(tr => tr.stop())
      try {
        const ctx = new AudioContext()
        const decoded = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer())
        // Resample to what the model wants, through an offline graph rather
        // than by hand, so the filtering is the browser's problem.
        const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE)
        const src = off.createBufferSource()
        src.buffer = decoded
        src.connect(off.destination)
        src.start()
        const out = await off.startRendering()
        await ctx.close()
        await upload(encodeWav(out.getChannelData(0), TARGET_RATE))
      } catch { setError('decode_failed') }
    }

    rec.start()
    setRecording(true); setLeft(RECORD_SECONDS)
    timerRef.current = window.setInterval(() => {
      setLeft(n => {
        if (n <= 1) { stop(); return 0 }
        return n - 1
      })
    }, 1000)
  }

  const forget = async () => {
    setBusy(true); setError(''); setDone('')
    try {
      const res = await auth.authFetch(`${API_URL}/api/speaker/enroll`, { method: 'DELETE' })
      if (res.ok) {
        onEnrolledChange(false)
        // Leaving it switched on with no voice on file would claim the gate is
        // filtering when the backend has dropped it from the pipeline.
        onEnabledChange(false)
      }
    } catch { setError('network') }
    finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between p-3.5 mb-2 bg-slate-50 border border-slate-200/60 rounded-xl">
        <div className="flex flex-col">
          <span className="text-xs font-bold text-slate-800">{t('settings.speakerGate')}</span>
          <span className="text-[10px] text-slate-400 mt-0.5 font-medium">
            {enrolled ? t('settings.speakerGateDesc') : t('settings.speakerGateNeedsVoice')}
          </span>
        </div>
        {/* Nothing to switch on before there is a voice to compare against —
            the backend would leave the gate out of the pipeline anyway. */}
        <input type="checkbox" checked={enabled} disabled={!enrolled}
          onChange={e => onEnabledChange(e.target.checked)}
          className="w-4.5 h-4.5 accent-slate-900 cursor-pointer rounded disabled:opacity-40 disabled:cursor-not-allowed" />
      </div>

      <div className="flex items-center gap-2">
        {recording ? (
          <button type="button" onClick={stop}
            className="flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-medium text-white">
            <Square className="w-3 h-3" /> {t('settings.speakerStop', { seconds: left })}
          </button>
        ) : (
          <button type="button" onClick={record} disabled={busy}
            className="flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mic className="w-3 h-3" />}
            {enrolled ? t('settings.speakerReRecord') : t('settings.speakerRecord')}
          </button>
        )}
        {enrolled && !recording && (
          <>
            <span className="flex items-center gap-1 text-[10px] text-emerald-700">
              <Check className="w-3 h-3" /> {t('settings.speakerEnrolled')}
            </span>
            <button type="button" onClick={forget} disabled={busy}
              title={t('settings.speakerForget')}
              className="ml-auto text-slate-300 hover:text-rose-600 disabled:opacity-40">
              <Trash2 className="w-3 h-3" />
            </button>
          </>
        )}
      </div>

      <span className="text-[10px] text-slate-400">{t('settings.speakerHint')}</span>

      <div className="flex items-center gap-2">
        <label className="text-[10px] text-slate-500 flex-shrink-0">
          {t('settings.speakerThreshold')}
        </label>
        <input type="range" min={0.2} max={0.9} step={0.05} value={threshold}
          onChange={e => onThresholdChange(Number(e.target.value))}
          className="flex-1 accent-slate-900" />
        <span className="text-[10px] tabular-nums text-slate-600 w-8">{threshold.toFixed(2)}</span>
      </div>

      {done && <p className="text-[10px] text-emerald-700">{done}</p>}
      {error && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {t(`settings.speakerError.${error}`, { defaultValue: t('settings.speakerError.failed') })}
        </p>
      )}
    </div>
  )
}
