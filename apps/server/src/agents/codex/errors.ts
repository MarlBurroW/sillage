import type { CodexErrorInfo, TurnError } from '@sillage/codex-bindings/v2'
import type { SillageEvent } from '@sillage/protocol'

type ErrorEvent = Extract<SillageEvent, { type: 'error' }>

/**
 * Sillage turn-failure code from codexErrorInfo. CLI failures use camelCase, sometimes object
 * variants carrying HTTP status. Logs require stable strings for web translation:
 * usageLimitExceeded becomes usage_limit_exceeded; object variants use their key. Unspecified
 * failures remain turn_failed so errors still display.
 */
export function codexErrorCode(info: CodexErrorInfo | null): string {
  if (info === null || info === 'other') return 'turn_failed'
  const name = typeof info === 'string' ? info : Object.keys(info)[0]
  if (!name) return 'turn_failed'
  const code = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  return RENAMED[code] ?? code
}

/**
 * Codes otherwise confused with Sillage HTTP errors: the web translates unauthorized as login
 * required, unrelated to rejected OpenAI accounts.
 */
const RENAMED: Record<string, string> = {
  unauthorized: 'provider_unauthorized',
}

/**
 * Turn-failure error event. Always recoverable because threads survive turns and the next message
 * starts another. Exhausted quota and overloaded servers warrant explaining silence rather than
 * closing conversations.
 */
export function describeTurnError(error: TurnError): ErrorEvent {
  const message = error.additionalDetails
    ? `${error.message}\n${error.additionalDetails}`
    : error.message
  return {
    type: 'error',
    code: codexErrorCode(error.codexErrorInfo),
    message,
    recoverable: true,
  }
}
