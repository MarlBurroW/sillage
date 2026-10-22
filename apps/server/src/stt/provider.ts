import { HttpError } from '../http/errors.js'

/** Minimal OpenAI-compatible API client, the common dialect of Groq, Mistral, OpenAI and self-hosted Whisper. No SDK: two endpoints suffice, and per-provider SDKs would defeat the shared format's purpose. */
export interface SttProvider {
  /** No trailing slash, for example `https://api.mistral.ai/v1`. */
  baseUrl: string
  model: string
  apiKey: string
}

interface AudioPayload {
  content: Buffer
  filename: string
  mimeType: string
}

/** `POST /audio/transcriptions` with vocabulary bias in `prompt`: Whisper interprets it as preceding transcript text and adapts its lexicon. */
export interface TranscriptionHints {
  /** Vocabulary bias interpreted by Whisper as preceding transcript text. */
  prompt?: string
  /** Forced ISO 639-1 language. Automatic detection is unreliable on short utterances: isolated 'test' can return German or Cyrillic. */
  language?: string
}

export async function transcribe(
  provider: SttProvider,
  audio: AudioPayload,
  hints: TranscriptionHints,
): Promise<string> {
  try {
    return await requestTranscription(provider, audio, hints)
  } catch (err) {
    // Some providers reject `prompt` or `language`: retry once without them rather
    // than break dictation over optional refinements.
    const hinted = hints.prompt || hints.language
    if (hinted && err instanceof HttpError && err.code === 'stt_provider_error') {
      return requestTranscription(provider, audio, {})
    }
    throw err
  }
}

async function requestTranscription(
  provider: SttProvider,
  audio: AudioPayload,
  hints: TranscriptionHints,
): Promise<string> {
  const body = new FormData()
  body.append('model', provider.model)
  body.append('file', new Blob([audio.content], { type: audio.mimeType }), audio.filename)
  if (hints.prompt) body.append('prompt', hints.prompt)
  if (hints.language) body.append('language', hints.language)

  const payload = await call(provider, '/audio/transcriptions', {
    body,
    timeoutMs: 120_000,
  })
  const text = (payload as { text?: unknown }).text
  if (typeof text !== 'string') throw providerError('no transcript in the response')
  return text
}

/** `POST /chat/completions` for lexicon generation and cleanup. */
export async function complete(
  provider: SttProvider,
  system: string,
  user: string,
): Promise<string> {
  const payload = await call(provider, '/chat/completions', {
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    contentType: 'application/json',
    timeoutMs: 30_000,
  })
  const content = (payload as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
    ?.message?.content
  if (typeof content !== 'string') throw providerError('no completion in the response')
  return content
}

/** Always include `detail` because translated error codes interpolate it. */
function providerError(detail: string): HttpError {
  return new HttpError(502, 'stt_provider_error', 'The provider refused the request: {detail}', {
    detail,
  })
}

async function call(
  provider: SttProvider,
  path: string,
  options: { body: FormData | string; contentType?: string; timeoutMs: number },
): Promise<unknown> {
  const response = await fetch(`${provider.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
    },
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs),
  }).catch((err: unknown) => {
    throw new HttpError(502, 'stt_provider_unreachable', 'Could not reach {baseUrl}: {reason}.', {
      baseUrl: provider.baseUrl,
      reason: err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err),
    })
  })

  const text = await response.text()
  if (!response.ok) {
    // Provider error bodies are the only diagnostic clue (incorrect
    // model, revoked key, quota): return it truncated rather than replace it.
    throw providerError(`${response.status} ${text.slice(0, 300) || response.statusText}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw providerError('unreadable JSON in the response')
  }
}
