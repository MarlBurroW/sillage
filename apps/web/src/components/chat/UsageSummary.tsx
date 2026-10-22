import type { ClaudeAccountDto } from '@sillage/protocol'
import type { RateLimitState } from '../../lib/chat-fold'
import { locale, translate, useTranslate, type MessageKey } from '../../lib/i18n'
import { formatTokens } from '../../lib/tokens'
import { cx } from '../ui'

/** Quota-window labels reported by the CLI. */
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
 * When utilization is absent, window duration alone adds nothing: show actionable time until reset
 * instead.
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
 * Actual conversation consumption. Subscription total_cost_usd is an unbilled API equivalent and
 * showing dollars would imply spending. Show quota, the exhaustible resource; money appears only
 * for usage-billed accounts.
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
  // Cache dominates actual usage: excluding it would show dozens of tokens instead of tens of thousands.
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
