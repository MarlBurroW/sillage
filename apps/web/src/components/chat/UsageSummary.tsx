import type { ClaudeAccountDto } from '@sillage/protocol'
import type { RateLimitState } from '../../lib/chat-fold'
import { cx } from '../ui'

/** Libellés des fenêtres de quota annoncées par le CLI. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 h',
  seven_day: '7 j',
  seven_day_opus: '7 j Opus',
  seven_day_sonnet: '7 j Sonnet',
  seven_day_overage_included: '7 j + dépassement',
  overage: 'dépassement',
}

function formatCountdown(resetsAt: number): string {
  const remaining = resetsAt - Date.now()
  if (remaining <= 0) return 'réinitialisé'

  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.round((remaining % 3_600_000) / 60_000)
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`
}

/**
 * Le CLI n'envoie pas toujours `utilization`. Dans ce cas, afficher la seule fenêtre
 * (« 5 h ») n'apprend rien : on montre le temps restant avant réinitialisation, qui
 * est l'information exploitable.
 */
function describeQuota(rateLimit: RateLimitState): string {
  const window = WINDOW_LABELS[rateLimit.type] ?? rateLimit.type
  if (rateLimit.utilization !== null) {
    return `${window} ${Math.round(rateLimit.utilization * 100)} %`
  }
  return rateLimit.resetsAt === null ? window : `${window} · ${formatCountdown(rateLimit.resetsAt)}`
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)} k`
  return `${(count / 1_000_000).toFixed(1)} M`
}

interface UsageSummaryProps {
  account: ClaudeAccountDto | null | undefined
  rateLimit: RateLimitState | null
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

/**
 * Ce que consomme réellement la conversation.
 *
 * Sur un abonnement, le CLI calcule bien un `total_cost_usd`, mais c'est un
 * équivalent API que personne ne facture : l'afficher en dollars laisserait croire à
 * une dépense. La ressource réellement épuisable est le quota, donc c'est lui qu'on
 * montre. Le montant n'apparaît que sur un compte facturé à l'usage.
 */
export function UsageSummary({
  account,
  rateLimit,
  costUsd,
  inputTokens,
  outputTokens,
  cacheCreationTokens,
  cacheReadTokens,
}: UsageSummaryProps) {
  // Le cache domine la consommation réelle : l'exclure du total afficherait quelques
  // dizaines de tokens là où la conversation en a consommé des dizaines de milliers.
  const tokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
  const showCost = account?.billedBySubscription === false && costUsd > 0

  return (
    <>
      {tokens > 0 ? (
        <span
          title={`Entrée ${inputTokens} · sortie ${outputTokens} · cache écrit ${cacheCreationTokens} · cache lu ${cacheReadTokens}`}
        >
          {formatTokens(tokens)} tok
        </span>
      ) : null}

      {rateLimit ? (
        <span
          className={cx(
            rateLimit.status === 'rejected' && 'text-critical',
            rateLimit.status === 'allowed_warning' && 'text-caution',
          )}
          title={
            rateLimit.resetsAt === null
              ? 'Quota de la fenêtre en cours'
              : `Quota réinitialisé le ${new Date(rateLimit.resetsAt).toLocaleString('fr-FR')}`
          }
        >
          {describeQuota(rateLimit)}
        </span>
      ) : null}

      {showCost ? <span title="Facturé à l'usage">{costUsd.toFixed(3)} $</span> : null}
    </>
  )
}
