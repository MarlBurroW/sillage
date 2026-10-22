import { Cron } from 'croner'
import { z } from 'zod'

/**
 * Five-field cron expression, validated by the library that will execute it.
 *
 * Croner rather than a regex: `31 2 * * *` and `0 0 30 2 *` look similar, but the second never
 * occurs. Only something capable of calculating the next occurrence can distinguish them.
 */
export const cronScheduleSchema = z.string().refine(
  (value) => {
    try {
      return new Cron(value, { paused: true }).nextRun() !== null
    } catch {
      return false
    }
  },
  { message: 'Invalid cron expression.' },
)

/**
 * Instance-wide settings.
 *
 * Readable by any signed-in account, writable only by administrators: nothing here is
 * sensitive, and the UI needs these values to tell users when their threads will be archived.
 */
export interface AppSettingsDto {
  autoArchiveDays: number
  autoArchiveSchedule: string
  /**
   * Voice dictation through any OpenAI-compatible API (`/audio/transcriptions`).
   *
   * `sttSecret` names a stored secret, never the key itself: its value stays on the server.
   * Empty first three fields disable dictation; empty `sttCleanupModel` disables only the
   * cleanup pass.
   */
  sttBaseUrl: string
  sttModel: string
  sttSecret: string
  sttCleanupModel: string
  /**
   * Simultaneously live CLI runners across all accounts.
   *
   * Limits machine memory, not open conversation count: beyond this, the server stops the
   * oldest idle runner, which resumes on the next message.
   */
  maxConcurrentSessions: number
  /**
   * Instance public root used in Sillage-generated links: webhooks, API responses, scheduled
   * tasks. Empty derives it from each request's `Host` header.
   */
  publicUrl: string
}

/** Result of a manually triggered archive pass. */
export interface ArchiveRunDto {
  archived: number
}

export const updateAppSettingsBodySchema = z.object({
  /**
   * Zero disables automatic archiving. The upper bound has no special significance; it excludes
   * meaningless values for a setting expressed in days.
   */
  autoArchiveDays: z.number().int().min(0).max(3650).optional(),
  autoArchiveSchedule: cronScheduleSchema.optional(),
  // Empty strings are valid everywhere: they disable the feature.
  sttBaseUrl: z
    .string()
    .trim()
    .refine((value) => value === '' || /^https?:\/\//.test(value), {
      message: 'Base URL must start with http:// or https://.',
    })
    .optional(),
  sttModel: z.string().trim().max(200).optional(),
  sttSecret: z.string().trim().max(200).optional(),
  sttCleanupModel: z.string().trim().max(200).optional(),
  /** Empty restores per-request inference; otherwise an http(s) origin without a path. */
  publicUrl: z
    .string()
    .trim()
    .max(300)
    .refine((value) => value === '' || /^https?:\/\/[^\s/?#]+$/.test(value.replace(/\/+$/, '')), {
      message: 'Public URL must be an http(s) origin such as https://sillage.example.com.',
    })
    .transform((value) => value.replace(/\/+$/, ''))
    .optional(),
  /**
   * At least one session, otherwise nothing can start. The upper bound excludes values that
   * would exhaust the machine first: at 400–500 MB per session, a hundred runners would need 50
   * GB.
   */
  maxConcurrentSessions: z.number().int().min(1).max(100).optional(),
})

/** Transcribed dictation result. */
export interface TranscriptionDto {
  text: string
}
