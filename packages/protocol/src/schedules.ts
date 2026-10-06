import { Cron } from 'croner'
import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config.js'
import { cronScheduleSchema } from './app-settings.js'
import { agentKindSchema, type AgentKind } from './events.js'

/**
 * Tâches planifiées : un prompt que le daemon rejoue à cadence fixe, chaque tir dans
 * une session neuve.
 *
 * Les bornes sont ici plutôt que dans le serveur parce que le formulaire les affiche et
 * que l'outil MCP `schedule_task` doit refuser la même chose que la route.
 */

/** En deçà, un tir n'a pas fini que le suivant arrive : c'est une boucle, pas une tâche. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 1
/** Un an : au-delà, c'est une date qu'on veut, pas un intervalle. */
export const MAX_SCHEDULE_INTERVAL_MINUTES = 366 * 24 * 60

export const MIN_SCHEDULE_DURATION_MINUTES = 1
export const MAX_SCHEDULE_DURATION_MINUTES = 24 * 60
/** Assez pour un audit, trop peu pour qu'un agent égaré coûte une nuit. */
export const DEFAULT_SCHEDULE_DURATION_MINUTES = 30

export const MAX_SCHEDULE_NAME_CHARS = 120
/** Même plafond qu'une mission de `start_session` : au-delà, un fichier que le prompt cite. */
export const MAX_SCHEDULE_PROMPT_CHARS = 20000

/**
 * Quand une tâche tire.
 *
 * Trois formes et non le seul motif cron : « toutes les 6 heures » se compte depuis le
 * dernier tir, ce qu'un motif ne sait pas dire, et une date unique n'a pas de motif du
 * tout. Les heures d'un motif se lisent dans le fuseau du serveur.
 */
export const scheduleCadenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    minutes: z.number().int().min(MIN_SCHEDULE_INTERVAL_MINUTES).max(MAX_SCHEDULE_INTERVAL_MINUTES),
  }),
  z.object({ kind: z.literal('cron'), expression: cronScheduleSchema }),
  z.object({ kind: z.literal('once'), at: z.number().int().positive() }),
])
export type ScheduleCadence = z.infer<typeof scheduleCadenceSchema>

/**
 * Sort d'un tir qui arrive pendant que le précédent tourne encore : `skip` le laisse
 * passer, `wait` le fait partir dès que la place est libre. Jamais deux en parallèle :
 * ils travailleraient le même arbre.
 */
export const scheduleOverlapPolicySchema = z.enum(['skip', 'wait'])
export type ScheduleOverlapPolicy = z.infer<typeof scheduleOverlapPolicySchema>

/** `fresh` : une session neuve par tir. Le mode continu viendra s'ajouter ici. */
export const scheduleExecutionModeSchema = z.enum(['fresh'])
export type ScheduleExecutionMode = z.infer<typeof scheduleExecutionModeSchema>

export const scheduleRunStatusSchema = z.enum(['running', 'succeeded', 'failed', 'timed_out', 'skipped'])
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>

export type ScheduleRunTrigger = 'schedule' | 'manual'

export const createScheduledTaskBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_SCHEDULE_NAME_CHARS),
  agent: agentKindSchema,
  config: agentConfigSchema,
  prompt: z.string().trim().min(1).max(MAX_SCHEDULE_PROMPT_CHARS),
  cadence: scheduleCadenceSchema,
  overlapPolicy: scheduleOverlapPolicySchema.default('skip'),
  maxDurationMinutes: z
    .number()
    .int()
    .min(MIN_SCHEDULE_DURATION_MINUTES)
    .max(MAX_SCHEDULE_DURATION_MINUTES)
    .default(DEFAULT_SCHEDULE_DURATION_MINUTES),
  enabled: z.boolean().default(true),
})

/** Tout est facultatif : la pause n'envoie que `enabled`. */
export const updateScheduledTaskBodySchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_SCHEDULE_NAME_CHARS),
    agent: agentKindSchema,
    config: agentConfigSchema,
    prompt: z.string().trim().min(1).max(MAX_SCHEDULE_PROMPT_CHARS),
    cadence: scheduleCadenceSchema,
    overlapPolicy: scheduleOverlapPolicySchema,
    maxDurationMinutes: z
      .number()
      .int()
      .min(MIN_SCHEDULE_DURATION_MINUTES)
      .max(MAX_SCHEDULE_DURATION_MINUTES),
    enabled: z.boolean(),
  })
  .partial()

export interface ScheduledRunDto {
  id: string
  taskId: string
  /** Null quand le tir n'a rien lancé, ou que son fil a été supprimé depuis. */
  conversationId: string | null
  trigger: ScheduleRunTrigger
  status: ScheduleRunStatus
  scheduledFor: number
  startedAt: number
  finishedAt: number | null
  error: string | null
}

export interface ScheduledTaskDto {
  id: string
  projectId: string
  userId: string
  name: string
  agent: AgentKind
  config: AgentConfig
  prompt: string
  cadence: ScheduleCadence
  executionMode: ScheduleExecutionMode
  overlapPolicy: ScheduleOverlapPolicy
  maxDurationMinutes: number
  enabled: boolean
  lastRunAt: number | null
  /** Null quand plus rien n'est prévu : en pause, ou ponctuelle déjà tirée. */
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
  /** Les derniers tirs, du plus récent au plus ancien. */
  runs: ScheduledRunDto[]
}

/**
 * Prochain tir d'une cadence après `after`, ou null s'il n'y en a plus.
 *
 * Partagé entre le daemon, qui arme, et le formulaire, qui montre ce qu'il va armer :
 * deux calculs finiraient par annoncer une heure et tirer à une autre.
 *
 * `lastRunAt` ne sert qu'à l'intervalle, qui se compte depuis le tir précédent. Sans
 * lui, le premier tir attend un intervalle entier : une tâche « toutes les 6 heures »
 * qui partirait à la création surprendrait, et « lancer maintenant » existe pour ça.
 */
export function nextScheduleRun(
  cadence: ScheduleCadence,
  after: number,
  lastRunAt: number | null = null,
): number | null {
  if (cadence.kind === 'once') return cadence.at > after ? cadence.at : null
  if (cadence.kind === 'interval') {
    const step = cadence.minutes * 60_000
    const next = (lastRunAt ?? after) + step
    // Un daemon resté arrêté plusieurs intervalles ne rattrape pas les tirs manqués.
    return next > after ? next : after + step
  }
  try {
    return new Cron(cadence.expression, { paused: true }).nextRun(new Date(after))?.getTime() ?? null
  } catch {
    return null
  }
}
