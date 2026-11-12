import type { UsageLimitResumeReason, UsageLimitStopDetails } from '@sillage/protocol'
import { locale, translate, type MessageKey } from './i18n'

/** Time of day, with the date when it is not today: a weekly limit lifts days later. */
export function formatLimitMoment(ts: number): string {
  const date = new Date(ts)
  const sameDay = date.toDateString() === new Date().toDateString()
  return date.toLocaleString(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
  })
}

const REASONS: Partial<Record<UsageLimitResumeReason, MessageKey>> = {
  disabled: 'usageLimit.reason.disabled',
  threshold: 'usageLimit.reason.threshold',
  schedule: 'usageLimit.reason.schedule',
  unknown_reset: 'usageLimit.reason.unknown_reset',
  already_resumed: 'usageLimit.reason.already_resumed',
}

export function describeLimitReason(reason: UsageLimitResumeReason | null): string {
  const key = reason ? REASONS[reason] : undefined
  return key ? translate(key) : translate('usageLimit.reason.other')
}

/** One line shared by the thread notice and the toast: when the limit lifts, and whether the session resumes. */
export function describeUsageLimitStop(details: UsageLimitStopDetails): string {
  if (details.resumeAt !== null && details.resetsAt !== null) {
    return translate('usageLimit.stop.resume', { reset: formatLimitMoment(details.resetsAt), resume: formatLimitMoment(details.resumeAt) })
  }
  const reason = describeLimitReason(details.reason)
  if (details.resetsAt !== null) return translate('usageLimit.stop.noResume', { reset: formatLimitMoment(details.resetsAt), reason })
  return translate('usageLimit.stop.unknown', { reason })
}

/** `details` comes from the journal: validate the shape rather than trust a newer or older server. */
export function readUsageLimitDetails(value: unknown): UsageLimitStopDetails | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const time = (field: unknown) => (typeof field === 'number' && Number.isFinite(field) ? field : null)
  return {
    resetsAt: time(record.resetsAt),
    resumeAt: time(record.resumeAt),
    reason: typeof record.reason === 'string' ? (record.reason as UsageLimitResumeReason) : null,
  }
}
