import { useState, useRef, useEffect } from 'react'

export default function useAudioVisualizer(active: boolean, barCount = 9): number[] {
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
    const idleBars = Array(barCount).fill(IDLE_BASE)

    if (!active) {
      cancelAnimationFrame(frameRef.current)
      setBars(idleBars)
      displayRef.current = idleBars
      targetRef.current = idleBars
      phaseRef.current = 0
      return
    }

    let running = true

    // Lower gate because RMS from getByteTimeDomainData is usually small.
    const NOISE_GATE = 0.12

    // Increase this if bars still feel too quiet.
    const INPUT_GAIN = 14

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
          window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

        if (!AudioContextClass) {
          console.warn('Audio visualizer: AudioContext not supported')
          return
        }

        const ctx = new AudioContextClass()
        audioCtxRef.current = ctx

        if (ctx.state === 'suspended') {
          await ctx.resume()
        }

        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.82
        analyserRef.current = analyser

        const source = ctx.createMediaStreamSource(stream)
        source.connect(analyser)

        timeDataRef.current = new Uint8Array(analyser.fftSize)

        const tick = () => {
          if (!running || !analyser || !timeDataRef.current) return

          analyser.getByteTimeDomainData(timeDataRef.current as any)

          let sum = 0

          for (let i = 0; i < timeDataRef.current.length; i++) {
            const centered = (timeDataRef.current[i] - 128) / 128
            sum += centered * centered
          }

          const rms = Math.sqrt(sum / timeDataRef.current.length)

          const rawEnergy = Math.min(1, rms * INPUT_GAIN)

          const energy =
            rawEnergy < NOISE_GATE
              ? 0
              : Math.min(1, (rawEnergy - NOISE_GATE) / (1 - NOISE_GATE))

          if (energy <= 0.001) {
            // No idle breathing. Completely fixed idle state.
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
      timeDataRef.current = null
    }
  }, [active, barCount])

  return bars
}