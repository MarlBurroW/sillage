import type {
  FastModeDisabledReason,
  FastModeState,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { SillageEvent } from '@sillage/protocol'

/**
 * Signaux du CLI qui ne sont ni du contenu ni une étape du tour, traduits en avis.
 *
 * Le runner jetait tout ce qu'il ne connaissait pas, et la liste de ce qui tombait dans
 * ce `default` avait grandi avec le CLI : crédits épuisés, API qui retente pendant deux
 * minutes, refus du modèle, refus automatique d'une permission. Chacun expliquait un
 * silence que personne ne pouvait expliquer depuis le fil.
 *
 * Fonctions pures, sans accès au runner : testables sans lancer de CLI, et sans effet
 * possible sur le tour. Les phrases sont rédigées ici, en français, comme celles de
 * l'adaptateur Codex : le journal porte la phrase, pas un code à traduire.
 */

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

/**
 * Traduit un signal, ou rend null pour tout message qui n'en est pas un.
 *
 * Appelée en dernier recours par le runner, après les messages qu'il traite lui-même :
 * ce qui revient null ici est réellement ignoré, et volontairement.
 */
export function translateSignal(message: SDKMessage): SillageEvent | null {
  if (message.type === 'prompt_suggestion') {
    return { type: 'suggestion.updated', text: message.suggestion }
  }
  if (message.type === 'conversation_reset') {
    return notice('conversation_reset', 'Contexte effacé : la session repart de zéro.', 'info')
  }
  if (message.type !== 'system') return null

  switch (message.subtype) {
    case 'notification':
      // Un même `key` décrit un même état (crédits épuisés, serveur MCP perdu), que le
      // CLI répète à chaque tour : le rendu remplace l'avis précédent plutôt que
      // d'empiler la répétition, le journal garde chaque occurrence.
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
        // Un seul repère pour toute la série : l'écran montre la dernière tentative.
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
      // Seuls les refus décidés sans personne passent par ici : classifieur du mode
      // auto, `dontAsk`, règle de refus. Ceux de l'utilisateur ont leur propre événement.
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
      // `info` n'est montré par le CLI qu'en mode transcript : c'est du détail de hook,
      // pas un avis. Les trois autres niveaux s'adressent à l'utilisateur.
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

/**
 * Motifs d'indisponibilité du mode rapide, dans les mots de la documentation. Ouvert
 * plutôt qu'exhaustif : un motif inconnu s'affiche par sa clé.
 */
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

/**
 * L'avis à journaliser pour un état du mode rapide, ou null quand il n'y a rien à dire.
 *
 * Rien à dire tant que personne ne l'a demandé et que le CLI le laisse éteint : c'est
 * l'état de toutes les conversations. Demandé et éteint, c'est un empêchement à nommer ;
 * allumé ou en pause, un changement de régime à marquer ; éteint après avoir été allumé,
 * la fin de ce régime. Un seul identifiant, pour que le fil montre le dernier état.
 */
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
