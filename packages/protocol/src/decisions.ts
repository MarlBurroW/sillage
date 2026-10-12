import { z } from 'zod'

/**
 * Les décisions : ce qu'une session autonome (tâche planifiée, automatisation,
 * maintenance du board) demande à un humain, sans se bloquer en l'attendant.
 *
 * Distinctes des demandes natives des CLI (permissions, questions, plans), qui
 * suspendent un tour et vivent dans leur conversation : une décision est déposée en
 * base, survit aux redémarrages, et sa réponse revient à la session sous forme de
 * message, qui la relance.
 */

export const MAX_DECISION_QUESTION_CHARS = 300
export const MAX_DECISION_CONTEXT_CHARS = 8000
export const MAX_DECISION_OPTIONS = 6
export const MAX_DECISION_OPTION_CHARS = 120
export const MAX_DECISION_ANSWER_CHARS = 4000
export const MAX_DECISION_HOURS = 168
export const DEFAULT_DECISION_HOURS = 24

/** D'où vient la session qui demande : ce qui l'a ouverte sans personne au clavier. */
export const decisionSourceKindSchema = z.enum(['schedule', 'webhook', 'board'])
export type DecisionSourceKind = z.infer<typeof decisionSourceKindSchema>

export const decisionStatusSchema = z.enum(['pending', 'answered', 'expired', 'withdrawn'])
export type DecisionStatus = z.infer<typeof decisionStatusSchema>

/**
 * Réglage de chaque source : l'outil n'est proposé à ses sessions que si l'utilisateur
 * l'a permis, et une demande n'attend pas plus que ce délai.
 */
export const decisionSettingsSchema = z.object({
  decisionsEnabled: z.boolean(),
  decisionMaxHours: z.number().int().min(1).max(MAX_DECISION_HOURS),
})
export type DecisionSettings = z.infer<typeof decisionSettingsSchema>

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  decisionsEnabled: false,
  decisionMaxHours: DEFAULT_DECISION_HOURS,
}

export interface DecisionSourceDto {
  kind: DecisionSourceKind
  /** Nom de la tâche ou de l'automatisation, « Issue #12 » pour la maintenance. */
  label: string
  taskId: string | null
  cardNumber: number | null
}

export interface DecisionAnswerDto {
  option: string | null
  text: string | null
  /** Null pour une échéance : personne n'a répondu, la réponse par défaut s'applique. */
  byName: string | null
  at: number
}

export interface DecisionDto {
  id: string
  projectId: string
  projectName: string
  conversationId: string
  conversationTitle: string | null
  source: DecisionSourceDto
  question: string
  context: string
  options: string[]
  /** Le choix appliqué à l'échéance ; null : « pas de réponse » est transmis tel quel. */
  defaultOption: string | null
  expiresAt: number
  status: DecisionStatus
  answer: DecisionAnswerDto | null
  /** Raison donnée par l'agent qui retire sa demande. */
  withdrawnReason: string | null
  createdAt: number
}

export const answerDecisionBodySchema = z
  .object({
    option: z.string().max(MAX_DECISION_OPTION_CHARS).nullable().default(null),
    text: z.string().trim().max(MAX_DECISION_ANSWER_CHARS).default(''),
  })
  .refine((body) => body.option !== null || body.text !== '', { message: 'Choose an option or write an answer.' })
