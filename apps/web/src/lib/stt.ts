import { useEffect, useRef, useState } from 'react'
import type { TranscriptionDto } from '@sillage/protocol'
import { ApiRequestError } from './api'
import { useAppSettings } from './app-settings'
import { translate, translateError } from './i18n'

/**
 * Dictée vocale du composer : enregistrement dans le navigateur, transcription par le
 * serveur (`/api/stt/transcribe`), qui la relaie au fournisseur configuré. Le module
 * ne touche jamais à une clé d'API, elle vit dans les secrets de l'instance.
 */

/** La dictée n'apparaît que si l'instance est configurée pour. */
export function useSttEnabled(): boolean {
  const { data: settings } = useAppSettings()
  return Boolean(settings?.sttBaseUrl && settings.sttModel && settings.sttSecret)
}

/**
 * L'envoi passe par `fetch` directement, comme les pièces jointes : un multipart
 * laisse le navigateur composer son en-tête `content-type`, frontière comprise.
 */
async function postAudio(path: string, audio: Blob, projectId?: string): Promise<unknown> {
  const extension = audio.type.includes('mp4') ? 'mp4' : 'webm'
  const body = new FormData()
  if (projectId) body.append('projectId', projectId)
  // Le fichier en dernier : @fastify/multipart ne lit que les champs qui précèdent.
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
 * Vérifie la configuration en parcourant le chemin d'une vraie dictée, sur un court
 * échantillon sonore. Il est synthétisé par WebAudio plutôt qu'enregistré : le test ne
 * doit pas demander l'accès au micro, ni dépendre de ce qu'il capte.
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

/** Format d'enregistrement que le navigateur sait produire, WebM partout sauf Safari. */
function recordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type))
}

export function useDictation({ projectId, onText, onError }: DictationOptions) {
  const [state, setState] = useState<DictationState>('idle')
  /** Branché sur le flux du micro pendant l'enregistrement, pour le vumètre. */
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const audio = useRef<AudioContext | null>(null)
  // Les callbacks se relisent au moment où la transcription aboutit, pas à celui où
  // l'enregistrement démarre : sans ces refs, `onText` insérerait dans un texte périmé.
  const callbacks = useRef({ onText, onError })
  callbacks.current = { onText, onError }

  // Un composer démonté en cours d'enregistrement doit rendre le micro au système.
  useEffect(
    () => () => {
      stopTracks(recorder.current)
      void audio.current?.close().catch(() => {})
    },
    [],
  )

  const start = async () => {
    if (state !== 'idle') return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      callbacks.current.onError(translate('composer.dictate.denied'))
      return
    }

    // L'analyseur écoute le même flux que l'enregistreur : ce que le vumètre montre
    // est ce qui part réellement, un mauvais micro sélectionné se voit tout de suite.
    const context = new AudioContext()
    const meter = context.createAnalyser()
    meter.fftSize = 1024
    context.createMediaStreamSource(stream).connect(meter)
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
