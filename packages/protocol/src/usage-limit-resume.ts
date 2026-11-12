import { z } from 'zod'

/**
 * Resuming sessions stopped mid-turn by a subscription usage limit.
 *
 * Account-level like notification preferences: the resumed work spends this account's quota,
 * and unattended work (overnight runs, delegated sub-sessions) is a personal working style, not
 * a project rule. Off by default: a resume that nobody asked for spends quota behind the user's
 * back.
 */
export interface UsageLimitResumePrefs {
  enabled: boolean
  /**
   * Hours past which a lifted limit no longer resumes the session. A weekly limit lifted days
   * later would restart work nobody wants anymore.
   */
  maxHours: number
  /** Text sent to the agent on resume; empty means `DEFAULT_USAGE_LIMIT_RESUME_MESSAGE`. */
  message: string
}

export const MAX_USAGE_LIMIT_RESUME_HOURS = 24 * 7
export const MAX_USAGE_LIMIT_RESUME_MESSAGE_CHARS = 2000

export const DEFAULT_USAGE_LIMIT_RESUME_MESSAGE =
  'The usage limit that stopped your previous turn has been lifted. Pick up exactly where you stopped and finish the work in progress.'

export const DEFAULT_USAGE_LIMIT_RESUME: UsageLimitResumePrefs = { enabled: false, maxHours: 12, message: '' }

export const usageLimitResumePrefsSchema = z.object({
  enabled: z.boolean().default(false).catch(false),
  maxHours: z.number().min(0.25).max(MAX_USAGE_LIMIT_RESUME_HOURS).default(12).catch(12),
  message: z.string().max(MAX_USAGE_LIMIT_RESUME_MESSAGE_CHARS).default('').catch(''),
})

/** Why a stopped session was not scheduled for resume, or why a scheduled resume did not happen. */
export const usageLimitResumeReasonSchema = z.enum([
  /** The account has not enabled automatic resume. */
  'disabled',
  /** The limit lifts later than the account's threshold. */
  'threshold',
  /** Scheduled runs restart from scratch at their next run: notify only. */
  'schedule',
  /** The CLI did not say when the limit lifts. */
  'unknown_reset',
  /** This session was already resumed once for this limit and stopped again without anyone writing in between. */
  'already_resumed',
  /** Someone wrote in the session before the limit lifted. */
  'user_message',
  /** The session was interrupted before the limit lifted. */
  'interrupted',
  /** The session was archived before the limit lifted. */
  'archived',
  /** The session was busy when the limit lifted. */
  'not_idle',
])
export type UsageLimitResumeReason = z.infer<typeof usageLimitResumeReasonSchema>

export type UsageLimitResumeStatus = 'scheduled' | 'resumed' | 'skipped' | 'cancelled'

/** Journaled with the `usage_limit_stop` notice so the thread can say what will happen. */
export interface UsageLimitStopDetails {
  resetsAt: number | null
  /** Null when the session will not resume by itself; `reason` says why. */
  resumeAt: number | null
  reason: UsageLimitResumeReason | null
}

export const USAGE_LIMIT_STOP_NOTICE = 'usage_limit_stop'
export const USAGE_LIMIT_RESUMED_NOTICE = 'usage_limit_resumed'
