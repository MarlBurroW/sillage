import { z } from 'zod'
import type { DecisionSourceKind } from './decisions.js'

/**
 * What Sillage reports outside the currently viewed conversation: a system notification on
 * subscribed devices or a toast in the open app. Never both on one device: the device with a
 * visible app gets the toast.
 */

/** Notification kinds, individually disableable by each account. */
export const notificationKindSchema = z.enum(['decision', 'cliRequest', 'turnCompleted'])
export type NotificationKind = z.infer<typeof notificationKindSchema>

export const notificationPrefsSchema = z.object({
  decision: z.boolean(),
  cliRequest: z.boolean(),
  turnCompleted: z.boolean(),
})
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { decision: true, cliRequest: true, turnCompleted: true }

/** What a CLI is waiting for, used in toast labels. */
export type CliRequestKind = 'permission' | 'question' | 'elicitation' | 'plan'

/**
 * A toast. Text is composed client-side in the user's language: the server sends only facts.
 */
export type InAppNotification =
  | {
      kind: 'decision'
      decisionId: string
      question: string
      sourceLabel: string
      /** Optional for clients newer than the server during deployment. */
      sourceKind?: DecisionSourceKind
      projectName: string
    }
  | {
      kind: 'cliRequest'
      request: CliRequestKind
      conversationId: string
      projectId: string | null
      conversationTitle: string
      /** Requested action in one line: tool and command, or the question asked. */
      detail: string | null
    }

/** Subscription push service inferred from its address, indicating the device type. */
export type PushServiceKind = 'apple' | 'google' | 'mozilla' | 'microsoft' | 'other'

export interface PushDeviceDto {
  endpoint: string
  service: PushServiceKind
  userAgent: string | null
  createdAt: number
}

/** Delay allowing time to close the app before the notification is sent. */
export const MAX_PUSH_TEST_DELAY_SECONDS = 60
export const pushTestBodySchema = z.object({
  delaySeconds: z.number().int().min(0).max(MAX_PUSH_TEST_DELAY_SECONDS),
})

export interface PushDeliveryDto {
  endpoint: string
  service: PushServiceKind
  /** `sent`: accepted by the push service; subsequent delivery is outside Sillage's control. */
  outcome: 'sent' | 'failed' | 'removed'
  /** HTTP status and rejection reason as returned by the service. */
  status: number | null
  reason: string | null
}

export interface PushTestDto {
  id: string
  sendAt: number
  /** Null until sending has occurred. */
  deliveries: PushDeliveryDto[] | null
}
