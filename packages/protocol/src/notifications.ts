import { z } from 'zod'
import type { DecisionSourceKind } from './decisions.js'

/**
 * Ce que Sillage signale hors de la conversation regardée : une notification système
 * sur les appareils abonnés, un toast dans l'application ouverte. Jamais les deux sur
 * le même appareil : celui où l'application est visible reçoit le toast.
 */

/** Les sortes de notifications, que chaque compte peut couper séparément. */
export const notificationKindSchema = z.enum(['decision', 'cliRequest', 'turnCompleted'])
export type NotificationKind = z.infer<typeof notificationKindSchema>

export const notificationPrefsSchema = z.object({
  decision: z.boolean(),
  cliRequest: z.boolean(),
  turnCompleted: z.boolean(),
})
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { decision: true, cliRequest: true, turnCompleted: true }

/** Ce qu'un CLI attend, pour le libellé d'un toast. */
export type CliRequestKind = 'permission' | 'question' | 'elicitation' | 'plan'

/**
 * Un toast. Le texte se compose côté client, dans sa langue : le serveur n'envoie que
 * des faits.
 */
export type InAppNotification =
  | {
      kind: 'decision'
      decisionId: string
      question: string
      sourceLabel: string
      /** Facultatif pour un client plus récent que le serveur, le temps d'un déploiement. */
      sourceKind?: DecisionSourceKind
      projectName: string
    }
  | {
      kind: 'cliRequest'
      request: CliRequestKind
      conversationId: string
      projectId: string
      conversationTitle: string
      /** Ce qui est demandé, en une ligne : l'outil et sa commande, la question posée. */
      detail: string | null
    }

/** Service de push d'un abonnement, lu dans son adresse : il dit quel appareil c'est. */
export type PushServiceKind = 'apple' | 'google' | 'mozilla' | 'microsoft' | 'other'

export interface PushDeviceDto {
  endpoint: string
  service: PushServiceKind
  userAgent: string | null
  createdAt: number
}

/** Un délai pour avoir le temps de fermer l'application avant que la notification parte. */
export const MAX_PUSH_TEST_DELAY_SECONDS = 60
export const pushTestBodySchema = z.object({
  delaySeconds: z.number().int().min(0).max(MAX_PUSH_TEST_DELAY_SECONDS),
})

export interface PushDeliveryDto {
  endpoint: string
  service: PushServiceKind
  /** `sent` : accepté par le service de push ; ce qui suit ne dépend plus de Sillage. */
  outcome: 'sent' | 'failed' | 'removed'
  /** Code HTTP et motif du refus, tels que le service les a donnés. */
  status: number | null
  reason: string | null
}

export interface PushTestDto {
  id: string
  sendAt: number
  /** Null tant que l'envoi n'a pas eu lieu. */
  deliveries: PushDeliveryDto[] | null
}
