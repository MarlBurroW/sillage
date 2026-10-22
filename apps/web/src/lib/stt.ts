import { useEffect, useRef, useState } from 'react'
import type { TranscriptionDto } from '@sillage/protocol'
import { ApiRequestError } from './api'
import { useAppSettings } from './app-settings'
import { locale, translate, translateError } from './i18n'

/**
 * Composer voice dictation: browser recording, then server transcription (`/api/stt/transcribe`)
 * relayed to the configured provider. This module never accesses an API key; keys remain in
 * instance secrets.
 */

/** Show dictation only when configured for the instance. */
export function useSttEnabled(): boolean {
  const { data: settings } = useAppSettings()
  return Boolean(settings?.sttBaseUrl && settings.sttModel && settings.sttSecret)
}

/**
 * Send directly with `fetch`, like attachments: let the browser build the multipart `content-type`
 * header with its boundary.
 */
async function postAudio(path: string, audio: Blob, projectId?: string): Promise<unknown> {
  const extension = audio.type.includes('mp4') ? 'mp4' : 'webm'
  const body = new FormData()
  if (projectId) body.append('projectId', projectId)
  // Dictate in the UI language: forcing it prevents automatic detection from interpreting an
  // isolated test as German.
  body.append('language', locale())
  // File last: @fastify/multipart reads only preceding fields.
  body.append('file', audio, `dictation.${extension}`)

  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    body,
  })

  const text = await response.text()
  const parsed: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    const payload = parsed as {
      error?: { code: string; message: string; params?: Record<string, string | number> }
    } | null
    const error = payload?.error
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'stt_failed',
      error
        ? translateError(error.code, error.message, error.params)
        : translate('error.http', { status: response.status }),
    )
  }
  return parsed
}

async function requestTranscription(audio: Blob, projectId?: string): Promise<string> {
  const parsed = await postAudio('/api/stt/transcribe', audio, projectId)
  return (parsed as TranscriptionDto).text
}

/**
 * Test configuration through the real dictation path using a short audio sample. Synthesize with
 * WebAudio instead of recording: testing must not request microphone access or depend on captured
 * sound.
 */
export async function testDictation(): Promise<{ cleanupTested: boolean }> {
  const audio = await recordTestTone()
  return (await postAudio('/api/stt/test', audio)) as { cleanupTested: boolean }
}

async function recordTestTone(): Promise<Blob> {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  gain.gain.value = 0.05
  oscillator.connect(gain).connect(destination)

  const recorder = new MediaRecorder(destination.stream, { mimeType: recordingMimeType() })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  oscillator.start()
  recorder.start()
  await new Promise((resolve) => setTimeout(resolve, 600))
  recorder.stop()
  oscillator.stop()
  await stopped
  await context.close()

  return new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
}

export type DictationState = 'idle' | 'recording' | 'transcribing'

interface DictationOptions {
  projectId?: string
  onText(text: string): void
  onError(message: string): void
}

/** Recording format supported by the browser: WebM everywhere except Safari. */
function recordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type))
}

export function useDictation({ projectId, onText, onError }: DictationOptions) {
  const [state, setState] = useState<DictationState>('idle')
  /** Connected to the microphone stream during recording for the level meter. */
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const audio = useRef<AudioContext | null>(null)
  /** Microphone stream clone dedicated to the level meter, stopped with the rest. */
  const monitor = useRef<MediaStream | null>(null)
  /**
   * Keep a live reference to the meter's source node. Otherwise Chrome considers it orphaned and
   * garbage-collects it mid-dictation: the analyzer shows one bar then flat zeros after GC.
   */
  const meterSource = useRef<MediaStreamAudioSourceNode | null>(null)
  // Read callbacks when transcription completes, not when recording starts: without refs `onText`
  // would insert into stale text.
  const callbacks = useRef({ onText, onError })
  callbacks.current = { onText, onError }

  // A composer unmounted while recording must release the microphone.
  useEffect(
    () => () => {
      stopTracks(recorder.current)
      monitor.current?.getTracks().forEach((track) => track.stop())
      void audio.current?.close().catch(() => {})
    },
    [],
  )

  const start = async () => {
    if (state !== 'idle') return

    // Create and resume within the touch gesture before awaiting: after awaiting microphone access,
    // the gesture is consumed and mobile Safari and Chrome Android refuse to resume a suspended
    // context. The analyzer would return flat zeros while recording works normally.
    const context = new AudioContext()
    void context.resume().catch(() => {})

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      void context.close().catch(() => {})
      callbacks.current.onError(translate('composer.dictate.denied'))
      return
    }

    // The analyzer listens to a cloned stream from the same microphone: Safari iOS starves one
    // output when MediaRecorder and WebAudio read the same MediaStream, making the meter go flat on
    // the first recorded sample.
    const meterStream = stream.clone()
    monitor.current = meterStream
    const meter = context.createAnalyser()
    meter.fftSize = 1024
    const source = context.createMediaStreamSource(meterStream)
    source.connect(meter)
    meterSource.current = source
    if (context.state !== 'running') void context.resume().catch(() => {})
    audio.current = context
    setAnalyser(meter)

    const chunks: Blob[] = []
    const media = new MediaRecorder(stream, { mimeType: recordingMimeType() })
    recorder.current = media

    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    media.onstop = () => {
      stopTracks(media)
      recorder.current = null
      meterStream.getTracks().forEach((track) => track.stop())
      monitor.current = null
      meterSource.current = null
      void context.close().catch(() => {})
      audio.current = null
      setAnalyser(null)

      const recording = new Blob(chunks, { type: media.mimeType || 'audio/webm' })
      if (recording.size === 0) {
        setState('idle')
        return
      }
      setState('transcribing')
      requestTranscription(recording, projectId)
        .then((text) => {
          if (text) callbacks.current.onText(text)
        })
        .catch((err: unknown) => {
          callbacks.current.onError(
            err instanceof Error ? err.message : translate('composer.dictate.failed'),
          )
        })
        .finally(() => setState('idle'))
    }

    media.start()
    setState('recording')
  }

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }

  return { state, analyser, toggle: state === 'recording' ? stop : start }
}

function stopTracks(media: MediaRecorder | null): void {
  media?.stream.getTracks().forEach((track) => track.stop())
}
