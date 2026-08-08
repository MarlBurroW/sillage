import { HttpError } from '../http/errors.js'

/**
 * Client minimal d'une API au format OpenAI, le dialecte commun de Groq, Mistral,
 * OpenAI et des Whisper auto-hébergés. Aucun SDK : deux endpoints suffisent, et un
 * SDK par fournisseur ruinerait justement l'intérêt du format partagé.
 */
export interface SttProvider {
  /** Sans barre oblique finale, `https://api.mistral.ai/v1` par exemple. */
  baseUrl: string
  model: string
  apiKey: string
}

interface AudioPayload {
  content: Buffer
  filename: string
  mimeType: string
}

/**
 * `POST /audio/transcriptions`, avec le biais de vocabulaire en paramètre `prompt` :
 * Whisper le lit comme du texte qui précéderait la dictée et cale son lexique dessus.
 */
export async function transcribe(
  provider: SttProvider,
  audio: AudioPayload,
  prompt: string | undefined,
): Promise<string> {
  try {
    return await requestTranscription(provider, audio, prompt)
  } catch (err) {
    // Tous les fournisseurs n'acceptent pas `prompt` : plutôt que de casser la dictée
    // sur ce raffinement, on retente une fois sans biais.
    if (prompt && err instanceof HttpError && err.code === 'stt_provider_error') {
      return requestTranscription(provider, audio, undefined)
    }
    throw err
  }
}

async function requestTranscription(
  provider: SttProvider,
  audio: AudioPayload,
  prompt: string | undefined,
): Promise<string> {
  const body = new FormData()
  body.append('model', provider.model)
  body.append('file', new Blob([audio.content], { type: audio.mimeType }), audio.filename)
  if (prompt) body.append('prompt', prompt)

  const payload = await call(provider, '/audio/transcriptions', {
    body,
    timeoutMs: 120_000,
  })
  const text = (payload as { text?: unknown }).text
  if (typeof text !== 'string') throw providerError('no transcript in the response')
  return text
}

/** `POST /chat/completions`, pour le lexique et la passe de nettoyage. */
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

/** Toujours un `detail` en paramètre : la traduction du code l'interpole. */
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
    // Le corps d'erreur du fournisseur est la seule piste de diagnostic (mauvais
    // modèle, clé révoquée, quota) : il remonte tronqué plutôt que remplacé.
    throw providerError(`${response.status} ${text.slice(0, 300) || response.statusText}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw providerError('unreadable JSON in the response')
  }
}
