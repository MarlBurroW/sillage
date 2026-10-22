import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config.js'
import { agentKindSchema } from './events.js'
import { DEFAULT_DECISION_HOURS, MAX_DECISION_HOURS } from './decisions.js'

/**
 * A board linked to an external source: GitHub repository issues become cards alongside local
 * cards, which stay local.
 *
 * GitHub is authoritative for its content (title, description, state, comments); Sillage adds
 * only what it alone knows: sessions and local notes. New cards stay local unless the board
 * specifies otherwise.
 *
 * Maintenance (sessions opened by an issue or comment) makes no decisions for the user: Sillage
 * supplies the trigger, context and marker identifying its publications. Agent actions and
 * replies follow the instructions written here.
 */

export const MAX_BOARD_LABEL_CHARS = 50
export const MAX_BOARD_INSTRUCTIONS_CHARS = 8000
export const MAX_BOARD_SIGNATURE_CHARS = 300
export const MAX_BOARD_SESSIONS_PER_HOUR = 100

/** `owner/name`, as written by GitHub. */
export const githubRepoSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { message: 'A GitHub repository, as owner/name.' })

export const boardNewCardsSchema = z.enum(['local', 'github'])
export type BoardNewCards = z.infer<typeof boardNewCardsSchema>

/**
 * Who speaks on GitHub: `developer` means the agent writes as the developer without visible
 * attribution; `ai` appends the chosen signature to every agent publication. The invisible
 * session marker is added in both cases.
 */
export const boardIdentitySchema = z.enum(['developer', 'ai'])
export type BoardIdentity = z.infer<typeof boardIdentitySchema>

/** A comment arriving while the session works: wait until the turn ends, or steer it. */
export const boardCommentDeliverySchema = z.enum(['queue', 'steer'])
export type BoardCommentDelivery = z.infer<typeof boardCommentDeliverySchema>

/** Where an issue session works: its `issue-<n>` worktree or the main tree. */
export const boardWorkspaceSchema = z.enum(['worktree', 'root'])
export type BoardWorkspace = z.infer<typeof boardWorkspaceSchema>

const label = z.string().trim().max(MAX_BOARD_LABEL_CHARS)
const instructions = z.string().max(MAX_BOARD_INSTRUCTIONS_CHARS)

export const boardLinkSettingsSchema = z
  .object({
    repo: githubRepoSchema,
    /** Only show issues carrying this label; empty shows all. */
    labelFilter: label,
    /** Issues closed within this many days remain visible. */
    closedDays: z.number().int().min(0).max(365),
    /** Destination of cards created on this board by a person or agent. */
    newCards: boardNewCardsSchema,
    /** Label placing an open issue in “in progress”. */
    progressLabel: label,
    /** Label placing an open issue in “review”. */
    reviewLabel: label,

    /** An issue opened on GitHub outside Sillage opens a session on its card. */
    onIssue: z.boolean(),
    issueInstructions: instructions,
    /** A comment written on GitHub outside Sillage reaches its issue's session. */
    onComment: z.boolean(),
    commentInstructions: instructions,
    commentDelivery: boardCommentDeliverySchema,
    /** Tone, language and commitments, shared by both triggers. */
    replyStyle: instructions,
    identity: boardIdentitySchema,
    signature: z.string().trim().max(MAX_BOARD_SIGNATURE_CHARS),
    /** CLI and settings for maintenance sessions; null uses project settings for that CLI. */
    sessionAgent: agentKindSchema,
    sessionConfig: agentConfigSchema.nullable(),
    workspace: boardWorkspaceSchema,
    /**
     * Maximum sessions opened and comments forwarded per hour. Needed only if a publication
     * lacks a marker (an agent forgetting it with `gh`): this stops the loop.
     */
    maxSessionsPerHour: z.number().int().min(1).max(MAX_BOARD_SESSIONS_PER_HOUR),
    /** Maintenance sessions may request a decision, waiting at most this long. */
    decisionsEnabled: z.boolean(),
    decisionMaxHours: z.number().int().min(1).max(MAX_DECISION_HOURS),
  })
  .refine((settings) => settings.sessionConfig === null || settings.sessionConfig.agent === settings.sessionAgent, {
    message: 'The session settings belong to another CLI.',
    path: ['sessionConfig'],
  })
export type BoardLinkSettings = z.infer<typeof boardLinkSettingsSchema>

export const DEFAULT_BOARD_SIGNATURE = '_Written by an AI agent._'

export const DEFAULT_BOARD_LINK_SETTINGS: Omit<BoardLinkSettings, 'repo'> = {
  labelFilter: '',
  closedDays: 14,
  newCards: 'local',
  progressLabel: 'in progress',
  reviewLabel: 'review',
  onIssue: false,
  issueInstructions: '',
  onComment: false,
  commentInstructions: '',
  commentDelivery: 'queue',
  replyStyle: '',
  identity: 'ai',
  signature: DEFAULT_BOARD_SIGNATURE,
  sessionAgent: 'claude',
  sessionConfig: null as AgentConfig | null,
  workspace: 'worktree',
  maxSessionsPerHour: 10,
  decisionsEnabled: false,
  decisionMaxHours: DEFAULT_DECISION_HOURS,
}

export interface BoardLinkDto extends BoardLinkSettings {
  projectId: string
  provider: 'github'
  url: string
  /** Account whose GitHub credential reads and writes, and which owns the sessions. */
  userId: string
  userName: string
  /** Issues manually removed from the board and skipped by sync. */
  hiddenCount: number
  lastSyncedAt: number | null
  /** Latest sync error code, translated by the UI. */
  lastError: string | null
  syncing: boolean
}

/** What the linking screen offers before a board is connected. */
export interface BoardLinkStateDto {
  link: BoardLinkDto | null
  /** Repository inferred from the local repository's `origin`, when it is GitHub. */
  suggestedRepo: string | null
  /** Current account has a github.com credential: linking requires it. */
  hasCredential: boolean
}
