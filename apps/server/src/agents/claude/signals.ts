import type {
  FastModeDisabledReason,
  FastModeState,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { SillageEvent } from '@sillage/protocol'

/** CLI signals outside content/turn steps normalized as notices. Previously ignored defaults hid exhausted credits, two-minute API retries, model rejections and automatic permission denials, leaving unexplained silence. Pure functions independent of runners are testable without CLIs and cannot affect turns. Like Codex notices, French sentences are journaled rather than translated codes. */

type Notice = Extract<SillageEvent, { type: 'agent.notice' }>

function notice(
  code: string,
  message: string,
  level: Notice['level'],
  details?: unknown,
  id?: string,
): Notice {
  return {
    type: 'agent.notice',
    code,
    message,
    level,
    ...(details === undefined ? {} : { details }),
    ...(id === undefined ? {} : { id }),
  }
}

/** Conversation resets from SDK 0.3.291 `conversation_reset.trigger`. Missing, older or unknown reasons retain generic messages because CLIs require identical handling for all resets. */
const RESET_MESSAGES: Record<string, string> = {
  clear: 'Contexte effacé : la session repart de zéro.',
  plan_mode_exit: 'Plan validé sur un contexte vidé : la session repart du seul plan.',
  fresh_session: 'Nouvelle session ouverte pour exécuter le plan validé.',
  onboarding: 'Accueil du CLI relancé : la session repart de zéro.',
}

/** Translates signals or returns null for nonsignals. Runner's last-resort handler after its own cases; null therefore means intentional omission. */
export function translateSignal(message: SDKMessage): SillageEvent | null {
  if (message.type === 'prompt_suggestion') {
    return { type: 'suggestion.updated', text: message.suggestion }
  }
  if (message.type === 'conversation_reset') {
    return notice('conversation_reset', RESET_MESSAGES[message.trigger ?? ''] ?? RESET_MESSAGES.clear!, 'info')
  }
  if (message.type !== 'system') return null

  switch (message.subtype) {
    case 'notification':
      // Repeated `key` values describe repeated states (credits exhausted, lost MCP):
      // rendering replaces notices rather than stacks duplicates,
      // while journals retain every occurrence.
      return notice(
        'notification',
        message.text,
        message.priority === 'high' || message.priority === 'immediate' ? 'warning' : 'info',
        undefined,
        `notification:${message.key}`,
      )

    case 'api_retry': {
      const status = message.error_status === null ? message.error : `HTTP ${message.error_status}`
      const delay = Math.max(1, Math.round(message.retry_delay_ms / 1000))
      return notice(
        'api_retry',
        `L'API n'a pas répondu (${status}) : nouvelle tentative ${message.attempt}/${message.max_retries} dans ${delay} s.`,
        'info',
        { error: message.error, status: message.error_status },
        // One marker for the series: screens show the latest attempt.
        'api-retry',
      )
    }

    case 'model_refusal_fallback': {
      const category = message.api_refusal_category ? ` (${message.api_refusal_category})` : ''
      const verb = message.direction === 'retry' ? 'réessaie avec' : 'passe à'
      return notice(
        'model_refusal',
        `${message.original_model} a refusé de répondre${category} : le CLI ${verb} ${message.fallback_model}.`,
        'warning',
        {
          content: message.content,
          explanation: message.api_refusal_explanation ?? null,
          direction: message.direction,
        },
      )
    }

    case 'model_refusal_no_fallback': {
      const category = message.api_refusal_category ? ` (${message.api_refusal_category})` : ''
      return notice(
        'model_refusal',
        `${message.original_model} a refusé de répondre${category}, sans modèle de repli.`,
        'warning',
        { content: message.content, explanation: message.api_refusal_explanation ?? null },
      )
    }

    case 'permission_denied': {
      // Only automatic denials reach here: auto classifiers, `dontAsk`, deny rules.
      // User decisions have their own events.
      const reason = message.decision_reason ? ` : ${message.decision_reason}` : ''
      return notice(
        'permission_denied',
        `Appel de ${message.tool_name} refusé automatiquement${reason}.`,
        'warning',
        {
          toolUseId: message.tool_use_id,
          by: message.decision_reason_type ?? null,
          message: message.message,
        },
      )
    }

    case 'informational':
      // CLI `info` appears only in transcript mode and describes hook details,
      // not notices. Other three levels address users.
      if (message.level === 'info') return null
      return notice(
        'informational',
        message.content,
        message.level === 'warning' ? 'warning' : 'info',
        message.prevent_continuation ? { preventContinuation: true } : undefined,
        message.tool_use_id ? `informational:${message.tool_use_id}` : undefined,
      )

    default:
      return null
  }
}

/** Fast-mode unavailability reasons using documentation terminology. Open-ended: unknown reasons display original keys. */
const FAST_MODE_REASONS: Record<string, string> = {
  free: 'réservé aux comptes payants',
  preference: 'désactivé dans les préférences du CLI',
  extra_usage_disabled: 'les crédits d’usage ne sont pas activés sur le compte',
  network_error: 'la vérification de disponibilité a échoué, réseau injoignable',
  unknown: 'motif non précisé par le CLI',
  not_first_party: 'indisponible hors de l’API Anthropic (Bedrock, Vertex, passerelle)',
  disabled_by_env: 'désactivé par CLAUDE_CODE_DISABLE_FAST_MODE',
  model_not_allowed: 'le modèle rapide n’est pas autorisé par l’organisation',
  sdk_opt_in_required: 'la session ne l’a pas demandé',
  pending: 'vérification de disponibilité en cours',
}

/** Notice for fast-mode state, or null. Say nothing when unrequested and disabled, the ordinary state. Requested but disabled needs explanation; active/paused marks regime changes; disabling after activation marks its end. One ID displays the latest state. */
export function describeFastMode(
  state: FastModeState,
  reason: FastModeDisabledReason | null,
  wanted: boolean,
  previous: FastModeState | null,
): Notice | null {
  const id = 'fast-mode'
  switch (state) {
    case 'on':
      return notice(
        'fast_mode',
        'Mode rapide activé : réponses plus rapides, facturées en crédits d’usage.',
        'info',
        undefined,
        id,
      )
    case 'cooldown':
      return notice(
        'fast_mode',
        'Mode rapide en pause : limite atteinte, vitesse normale en attendant.',
        'warning',
        undefined,
        id,
      )
    case 'off': {
      if (!wanted) {
        if (previous === null || previous === 'off') return null
        return notice('fast_mode', 'Mode rapide désactivé.', 'info', undefined, id)
      }
      const why = reason ? (FAST_MODE_REASONS[reason] ?? reason) : 'motif non précisé'
      return notice(
        'fast_mode',
        `Mode rapide indisponible : ${why}.`,
        'warning',
        reason ? { reason } : undefined,
        id,
      )
    }
  }
}

/** `init.plugin_errors` shape typed by SDK 0.3.291. */
export interface PluginLoadError {
  plugin: string
  type: string
  message: string
  path?: string
}

/** Plugins rejected during initialization. Sillage delivers skill libraries as plugins, so silent rejections otherwise merely remove skills without explanation. One notice ID displays latest state; null when all loaded. */
export function describePluginErrors(errors: PluginLoadError[] | undefined): Notice | null {
  if (!errors || errors.length === 0) return null
  const lines = errors.map((error) => `${error.plugin}${error.path ? ` (${error.path})` : ''} : ${error.message}`)
  const message =
    errors.length === 1
      ? `Plugin non chargé par Claude Code, ${lines[0]}`
      : `${errors.length} plugins non chargés par Claude Code :\n${lines.map((line) => `- ${line}`).join('\n')}`
  return notice('plugin_errors', message, 'warning', errors, 'plugin-errors')
}
