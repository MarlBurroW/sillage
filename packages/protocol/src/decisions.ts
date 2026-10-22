import { z } from 'zod'

/**
 * Decisions: requests from autonomous sessions (scheduled tasks, automations, board
 * maintenance) to a human, without blocking while waiting.
 *
 * Separate from native CLI requests (permissions, questions, plans), which suspend a turn and
 * live within their conversation: decisions are stored in the database, survive restarts, and
 * return to the session as a message that wakes it.
 */

export const MAX_DECISION_QUESTION_CHARS = 300
export const MAX_DECISION_CONTEXT_CHARS = 8000
export const MAX_DECISION_OPTIONS = 6
export const MAX_DECISION_OPTION_CHARS = 120
export const MAX_DECISION_ANSWER_CHARS = 4000
export const MAX_DECISION_HOURS = 168
export const DEFAULT_DECISION_HOURS = 24

/**
 * Request origin: what opened the session without a person at the keyboard. `worktree` is
 * retained to read older cleanup proposals.
 */
export const decisionSourceKindSchema = z.enum(['schedule', 'webhook', 'board', 'worktree'])
export type DecisionSourceKind = z.infer<typeof decisionSourceKindSchema>

/**
 * Sources every client can display because they predate selectable sources. Later sources are
 * served only to clients naming them in `sources`: a tab still using an older UI during an
 * update never receives a decision it cannot render.
 */
export const BASELINE_DECISION_SOURCES: readonly DecisionSourceKind[] = ['schedule', 'webhook', 'board']

/** Sources requested by a client (`?sources=a,b`), always including baseline sources. */
export function requestedDecisionSources(raw: unknown): DecisionSourceKind[] {
  const asked = typeof raw === 'string' ? raw.split(',').map((entry) => entry.trim()) : []
  const known = asked.filter((entry): entry is DecisionSourceKind => decisionSourceKindSchema.safeParse(entry).success)
  return [...new Set([...BASELINE_DECISION_SOURCES, ...known])]
}

export const decisionStatusSchema = z.enum(['pending', 'answered', 'expired', 'withdrawn'])
export type DecisionStatus = z.infer<typeof decisionStatusSchema>

/**
 * Per-source settings: sessions get the tool only if enabled by the user, and requests wait no
 * longer than this deadline.
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
  /** Task or automation name; “Issue #12” for maintenance. */
  label: string
  taskId: string | null
  cardNumber: number | null
  /** Worktree targeted by a cleanup proposal; null for other sources. */
  worktreePath: string | null
}

/**
 * Cleanup-proposal choices. Keys rather than sentences: the server does not know the reader's
 * language; the UI translates them.
 */
export const WORKTREE_DECISION_OPTIONS = ['clean', 'keep'] as const

export interface DecisionAnswerDto {
  option: string | null
  text: string | null
  /** Null at deadline: nobody answered, so the default applies. */
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
  /** Choice applied at deadline; null forwards “no answer” as-is. */
  defaultOption: string | null
  expiresAt: number
  status: DecisionStatus
  answer: DecisionAnswerDto | null
  /** Reason supplied by the agent withdrawing its request. */
  withdrawnReason: string | null
  createdAt: number
}

export const answerDecisionBodySchema = z
  .object({
    option: z.string().max(MAX_DECISION_OPTION_CHARS).nullable().default(null),
    text: z.string().trim().max(MAX_DECISION_ANSWER_CHARS).default(''),
  })
  .refine((body) => body.option !== null || body.text !== '', { message: 'Choose an option or write an answer.' })
