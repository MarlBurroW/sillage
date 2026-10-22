import type { ApiError } from '@sillage/protocol'
import { translate, translateError } from './i18n'

/**
 * API error as displayed in the UI. Translate at construction in this single location: every call
 * goes through `request`, so components displaying `err.message` need no i18n knowledge. Keep
 * `code` exposed for callers handling specific cases instead of displaying text.
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
      // Responses without usable bodies (proxy, disconnect) have neither code nor message: HTTP
      // status is the only accurate information available.
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
  // DELETE bodies carry entry paths instead of URL-encoding them, consistent with other panel operations.
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}
