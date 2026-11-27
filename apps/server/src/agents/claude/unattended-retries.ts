/**
 * How long Claude Code waits out an overloaded API (529) or a rate limit (429) when nobody is
 * watching the session.
 *
 * By default the CLI retries a few times with a short backoff and then fails the turn, which suits
 * a person at the keyboard who can resend. A scheduled task, a webhook automation or an API task
 * has nobody to resend: a burst of 529s fails the run where a longer wait would have saved it. The
 * CLI's unattended retry mode (`CLAUDE_CODE_RETRY_WATCHDOG`, 2.1.295) keeps retrying until a total
 * wait bound, and the overload backoff ceiling (`CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`,
 * 2.1.296) spaces the attempts out. All four names and their accepted ranges were checked in the
 * 2.1.332 binary.
 */

/** Total wait bound for an unattended run: long enough for a typical overload burst. */
export const UNATTENDED_RETRY_MAX_WAIT_MS = 30 * 60_000

/**
 * Ceiling of the backoff between two overload retries (the CLI accepts 32 000–300 000; its own is
 * about 32 s). Jitter comes on top: against a fake API answering 529, gaps reached 145 s at a 120 s
 * ceiling, noticing the end of a burst minutes late, and 91 s at one minute, which spaces attempts
 * out without that.
 */
export const UNATTENDED_OVERLOADED_MAX_DELAY_MS = 60_000

/** Where a conversation came from, as far as retries are concerned. */
export interface RetryOrigin {
  /** Set for scheduled tasks and webhook automations, which both run through the scheduler. */
  scheduleId: string | null
  /** Set for API v1 tasks (REST or MCP over HTTP). */
  createdByTokenId: string | null
  /** The scheduled task's maximum duration, when the conversation belongs to one that still exists. */
  maxDurationMinutes: number | null
}

/**
 * Environment additions for a Claude launch; empty for an interactive conversation, which keeps
 * the CLI's fail-fast defaults.
 *
 * The bound stays at half the task's maximum duration: the scheduler interrupts the run at that
 * duration, and a run that spent all of it waiting would end on a misleading “maximum duration”
 * rather than on the overload error. A subscription usage limit is not waited out
 * (`…_MAX_USAGE_LIMIT_WAIT_MS` = 1 ms): the watchdog would otherwise sleep until the reset, hours
 * away, while Sillage's usage-limit service already reports it and resumes the session.
 *
 * A variable already present in the daemon's environment is left alone, so an administrator's
 * choice (including turning the watchdog off) wins over these defaults.
 */
export function unattendedRetryEnv(origin: RetryOrigin, daemonEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (origin.scheduleId === null && origin.createdByTokenId === null) return {}
  const bound = origin.scheduleId !== null && origin.maxDurationMinutes !== null
    ? Math.min(UNATTENDED_RETRY_MAX_WAIT_MS, Math.floor((origin.maxDurationMinutes * 60_000) / 2))
    : UNATTENDED_RETRY_MAX_WAIT_MS
  const wanted: Record<string, string> = {
    CLAUDE_CODE_RETRY_WATCHDOG: '1',
    CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(Math.max(1, bound)),
    CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '1',
    CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS: String(UNATTENDED_OVERLOADED_MAX_DELAY_MS),
  }
  return Object.fromEntries(Object.entries(wanted).filter(([name]) => daemonEnv[name] === undefined))
}
