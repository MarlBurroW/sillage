import type { EventOf } from '@sillage/opencode-bindings'
import type { SillageEvent } from '@sillage/protocol'

type ErrorEvent = Extract<SillageEvent, { type: 'error' }>

export type SessionError = NonNullable<EventOf<'session.error'>['properties']['error']>

/** Un tour interrompu n'est pas une panne : opencode le dit pourtant par une erreur. */
export function isAbort(error: SessionError): boolean {
  return error.name === 'MessageAbortedError'
}

/**
 * Codes qui ont déjà une traduction côté web. Les autres erreurs d'opencode prennent
 * leur nom en snake_case (`ContextOverflowError` devient `context_overflow`), et une
 * panne sans précision reste `turn_failed`, pour être tout de même affichée.
 */
const RENAMED: Record<string, string> = {
  ProviderAuthError: 'provider_unauthorized',
  APIError: 'api_error',
  UnknownError: 'turn_failed',
}

export function opencodeErrorCode(name: string): string {
  const renamed = RENAMED[name]
  if (renamed) return renamed
  const code = name
    .replace(/Error$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
  return code || 'turn_failed'
}

/**
 * Événement `error` d'une panne de tour. Toujours `recoverable` : la session survit à
 * son tour, et le message suivant en ouvre un nouveau.
 */
export function describeSessionError(error: SessionError): ErrorEvent {
  const data = error.data as { message?: unknown } | undefined
  return {
    type: 'error',
    code: opencodeErrorCode(error.name),
    message: typeof data?.message === 'string' && data.message ? data.message : error.name,
    recoverable: true,
  }
}
