import type { ClaudeAccountDto } from '@sillage/protocol'
import type { RateLimitState } from '../../lib/chat-fold'
import { locale, translate, useTranslate, type MessageKey } from '../../lib/i18n'
import { formatTokens } from '../../lib/tokens'
import { cx } from '../ui'

/** Libellés des fenêtres de quota annoncées par le CLI. */
const WINDOW_LABEL_KEYS: Record<string, MessageKey> = {
  five_hour: 'usage.window.fiveHour',
  seven_day: 'usage.window.sevenDay',
  seven_day_opus: 'usage.window.sevenDayOpus',
  seven_day_sonnet: 'usage.window.sevenDaySonnet',
  seven_day_overage_included: 'usage.window.sevenDayOverageIncluded',
  overage: 'usage.window.overage',
}

function windowLabel(type: string): string {
  const key = WINDOW_LABEL_KEYS[type]
  return key ? translate(key) : type
}

function formatCountdown(resetsAt: number): string {
  const remaining = resetsAt - Date.now()
  if (remaining <= 0) return translate('usage.quota.reset')

  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.round((remaining % 3_600_000) / 60_000)
  return hours > 0
    ? translate('usage.quota.countdown.hours', { hours, minutes })
    : translate('usage.quota.countdown.minutes', { minutes })
}

/**
 * Le CLI n'envoie pas toujours `utilization`. Dans ce cas, afficher la seule fenêtre
 * (« 5 h ») n'apprend rien : on montre le temps restant avant réinitialisation, qui
 * est l'information exploitable.
 */
function describeQuota(rateLimit: RateLimitState): string {
  const window = windowLabel(rateLimit.type)
  if (rateLimit.utilization !== null) {
    return translate('usage.quota.utilization', {
      window,
      percent: Math.round(rateLimit.utilization * 100),
    })
  }
  return rateLimit.resetsAt === null
    ? window
    : translate('usage.quota.countdownFor', { window, countdown: formatCountdown(rateLimit.resetsAt) })
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
  const t = useTranslate()
  // Le cache domine la consommation réelle : l'exclure du total afficherait quelques
  // dizaines de tokens là où la conversation en a consommé des dizaines de milliers.
  const tokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
  const showCost = account?.billedBySubscription === false && costUsd > 0

  return (
    <>
      {tokens > 0 ? (
        <span
          title={t('usage.tokens.breakdown', {
            input: inputTokens,
            output: outputTokens,
            cacheWrite: cacheCreationTokens,
            cacheRead: cacheReadTokens,
          })}
        >
          {t('usage.tokens.total', { count: formatTokens(tokens) })}
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
              ? t('usage.quota.current')
              : t('usage.quota.resetAt', {
                  date: new Date(rateLimit.resetsAt).toLocaleString(locale()),
                })
          }
        >
          {describeQuota(rateLimit)}
        </span>
      ) : null}

      {showCost ? <span title={t('usage.billed.perUse')}>{t('usage.cost.amount', { amount: costUsd.toFixed(3) })}</span> : null}
    </>
  )
}
