import type { EventOf } from '@sillage/opencode-bindings'
import type { SillageEvent } from '@sillage/protocol'

type ErrorEvent = Extract<SillageEvent, { type: 'error' }>

export type SessionError = NonNullable<EventOf<'session.error'>['properties']['error']>

/** Interrupted turns are not failures, though opencode reports errors. */
export function isAbort(error: SessionError): boolean {
  return error.name === 'MessageAbortedError'
}

/**
 * Codes already translated by web. Other errors get snake_case names (ContextOverflowError →
 * context_overflow); unspecified failures remain turn_failed so they display.
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

/** Turn-failure error event. Always recoverable: session survives turn, next message starts another. */
export function describeSessionError(error: SessionError): ErrorEvent {
  const data = error.data as { message?: unknown } | undefined
  return {
    type: 'error',
    code: opencodeErrorCode(error.name),
    message: typeof data?.message === 'string' && data.message ? data.message : error.name,
    recoverable: true,
  }
}
