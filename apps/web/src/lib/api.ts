import type { ApiError } from '@sillage/protocol'
import { translate, translateError } from './i18n'

/**
 * Erreur d'API telle que l'interface l'affiche.
 *
 * Le message est déjà traduit à la construction, et c'est le seul endroit où ça se joue :
 * tous les appels passent par `request`, donc les composants qui affichent `err.message`
 * n'ont rien à savoir de l'i18n. Le `code` reste exposé pour ceux qui distinguent un cas
 * précis plutôt que d'afficher la phrase.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null

  if (!response.ok) {
    const payload = parsed as ApiError | null
    const error = payload?.error
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'unknown',
      // Une réponse sans corps exploitable (proxy, coupure) n'a ni code ni message : le
      // statut HTTP est alors tout ce qu'on peut dire honnêtement.
      error
        ? translateError(error.code, error.message, error.params)
        : translate('error.http', { status: response.status }),
    )
  }

  return parsed as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  // Un corps sur DELETE : la suppression d'une entrée porte un chemin, qui n'a pas à
  // être encodé dans l'URL alors que les autres opérations du panneau l'envoient ainsi.
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}
