import type { CodexErrorInfo, TurnError } from '@sillage/codex-bindings/v2'
import type { SillageEvent } from '@sillage/protocol'

type ErrorEvent = Extract<SillageEvent, { type: 'error' }>

/**
 * Code Sillage d'une panne de tour Codex, à partir de `codexErrorInfo`.
 *
 * Le CLI nomme ses pannes en camelCase, parfois sous forme d'objet quand un statut
 * HTTP les accompagne. Le journal attend une chaîne stable et le web traduit sur
 * cette chaîne : `usageLimitExceeded` devient `usage_limit_exceeded`, et un variant
 * objet prend le nom de sa clé. Un tour échoué sans précision reste `turn_failed`,
 * pour que la panne soit tout de même affichée.
 */
export function codexErrorCode(info: CodexErrorInfo | null): string {
  if (info === null || info === 'other') return 'turn_failed'
  const name = typeof info === 'string' ? info : Object.keys(info)[0]
  if (!name) return 'turn_failed'
  const code = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  return RENAMED[code] ?? code
}

/**
 * Codes qui, tels quels, se confondraient avec une erreur HTTP de Sillage : le web
 * traduit `unauthorized` en « connexion requise », ce qui n'a rien à voir avec un
 * compte OpenAI refusé.
 */
const RENAMED: Record<string, string> = {
  unauthorized: 'provider_unauthorized',
}

/**
 * Événement `error` d'une panne de tour.
 *
 * Toujours `recoverable` : le thread survit à son tour, et le message suivant en
 * ouvre un nouveau. Un quota épuisé ou un serveur surchargé ne justifie pas de
 * fermer la conversation, seulement de dire pourquoi elle s'est tue.
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
