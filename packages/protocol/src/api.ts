import { z } from 'zod'
import { agentConfigSchema, type CodexMode } from './agent-config.js'
// Type-only imports in both directions: `cards.ts` needs conversation status,
// and this file needs the card badge. Nothing survives at runtime,
// so there is no module cycle.
import type { CardColumn, CardLinkDto } from './cards.js'
import { elicitationActionSchema, elicitationContentSchema } from './elicitation.js'
import { agentKindSchema, type AgentKind } from './events.js'
import { mcpServerNameSchema, mcpTransportSchema, type McpServer } from './mcp.js'
import { instructionsModeSchema, type InstructionsMode } from './instructions.js'
import { memoryModeSchema, type MemoryMode } from './memory.js'
import type { ProjectAgentDefaults } from './project-defaults.js'
import { MAX_SKILLS_PER_MESSAGE } from './skills.js'

export const conversationStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting_input',
  'interrupted',
  'error',
])
export type ConversationStatus = z.infer<typeof conversationStatusSchema>

export const projectVisibilitySchema = z.enum(['private', 'shared'])
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>

// Auth

export const loginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

export interface CurrentUser {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
}

// Account administration

const PASSWORD_MIN = 8

export const createUserBodySchema = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, 'Lettres, chiffres, point, tiret et souligné uniquement'),
  displayName: z.string().min(1).max(120),
  password: z.string().min(PASSWORD_MIN, `Au moins ${PASSWORD_MIN} caractères.`).max(256),
  isAdmin: z.boolean().default(false),
})

/**
 * First account, created by onboarding when the database has none. Automatically an
 * administrator, as on the command line: nobody else could promote it.
 */
export const setupAccountBodySchema = createUserBodySchema.omit({ isAdmin: true })

/** Same constraint as creation: the identifier is the login name. */
const usernameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9._-]+$/i, 'Lettres, chiffres, point, tiret et souligné uniquement')

export const updateUserBodySchema = z
  .object({
    username: usernameSchema,
    displayName: z.string().min(1).max(120),
    isAdmin: z.boolean(),
    /**
     * An administrator reset signs the account out everywhere. For one's own account,
     * `currentPassword` is required and the current session is retained.
     */
    password: z.string().min(PASSWORD_MIN, `Au moins ${PASSWORD_MIN} caractères.`).max(256),
    currentPassword: z.string().min(1).max(256),
  })
  .partial()

export interface UserDto {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
  createdAt: number
  /** Open sessions: indicates whether the account is actually used anywhere. */
  activeSessions: number
  /**
   * Resources preventing deletion. `users` foreign keys do not cascade: deleting an account
   * that owns projects would break the database.
   */
  ownedProjects: number
  ownedConversations: number
}

// Projects

const projectCreationFields = {
  name: z.string().min(1).max(120),
  visibility: projectVisibilitySchema.default('private'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  /** Absent: the repository if it already contains `AGENTS.md` or `CLAUDE.md`; otherwise Sillage. */
  instructionsMode: instructionsModeSchema.optional(),
  /** Absent: the account default. */
  memoryMode: memoryModeSchema.optional(),
}

/**
 * Two ways to specify a project's workspace.
 *
 * `workspacePath` points to an existing directory anywhere on the machine. `parentDir` +
 * `directory` ask the server to create it: the usual case when starting a project from scratch
 * with only a name.
 */
export const createProjectBodySchema = z.union([
  z.object({ ...projectCreationFields, workspacePath: z.string().min(1) }),
  z.object({
    ...projectCreationFields,
    parentDir: z.string().min(1),
    directory: z.string().min(1).max(120),
  }),
])

/**
 * Onboarding sample project: Sillage writes a small repository under `parentDir` and creates a
 * project for it. Its distinctive directory name makes it easy to recognize and remove.
 */
export const createSampleProjectBodySchema = z.object({
  parentDir: z.string().min(1),
  visibility: projectVisibilitySchema.default('private'),
})

/**
 * Directory name derived from a project name: `Mon Projet Été` becomes `mon-projet-ete`.
 *
 * Lowercase, without accents or characters requiring shell escaping. Only a suggestion: the
 * field remains editable, and the server independently checks that the submitted value is a
 * simple directory name.
 */
export function slugifyProjectName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const updateProjectBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    /** Takes effect on the next runner launch, not on already running ones. */
    workspacePath: z.string().min(1),
    visibility: projectVisibilitySchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    /**
     * Preset for a single explicitly named CLI, rather than inferred from the discriminant:
     * `config: null` removes a preset, so the CLI must be specified. Other CLI presets retain
     * their values, as with account defaults.
     */
    defaultConfig: z
      .object({ agent: agentKindSchema, config: agentConfigSchema.nullable() })
      .refine((value) => value.config === null || value.config.agent === value.agent, {
        message: 'The configuration must belong to the named agent.',
      }),
    archived: z.boolean(),
    turnCheckpoints: z.boolean(),
    memoryMode: memoryModeSchema,
  })
  .partial()

/** Manual sidebar project order, top to bottom. */
export const reorderProjectsBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
})

/**
 * Project image size limit. Displayed at a few dozen pixels and stored in the database: the
 * browser downsizes uploads, and an agent supplying a larger image is asked to shrink it.
 */
export const MAX_PROJECT_IMAGE_BYTES = 1024 * 1024

/** Recognized by content, never by extension. */
export const PROJECT_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const

export interface ProjectImageDto {
  /** Versioned: replacing an image changes its URL, requiring no cache invalidation. */
  url: string
  /** Set by an agent pending a real logo. */
  provisional: boolean
}

export interface ProjectDto {
  id: string
  name: string
  /** Null until a person or agent sets one: color remains the visual marker. */
  image: ProjectImageDto | null
  workspacePath: string
  ownerId: string
  ownerName: string
  visibility: ProjectVisibility
  color: string | null
  isOwner: boolean
  position: number
  archivedAt: number | null
  createdAt: number
  conversationCount: number
  /** Project presets, the baseline for conversations opened within it. */
  defaultConfig: ProjectAgentDefaults
  /** Null for projects predating the setting: resolve the mode from the directory. */
  instructionsMode: InstructionsMode | null
  /** Git checkpoints per turn (see server-side `checkpoints.ts`). */
  turnCheckpoints: boolean
  /** Where this project's agent memory lives (see `memory.ts`). */
  memoryMode: MemoryMode
  /** Live shells in the project, indicating a terminal is still running. */
  activeTerminals: number
  /**
   * Board card counts per column, summarizing it in navigation without loading cards. Empty
   * columns are absent rather than zero.
   */
  cardCounts: Partial<Record<CardColumn, number>>
  /** Pinned to the top of the picker by the calling account: a personal marker. */
  pinned: boolean
  /** Git repository state; null if the workspace is not a repository. */
  git: { branch: string; isDirty: boolean } | null
}

// Attachments

export const MAX_ATTACHMENTS_PER_MESSAGE = 5

/**
 * Maximum mentions per message. Each injects an entire file into context: beyond this, one
 * message would consume the whole window.
 */
export const MAX_MENTIONS_PER_MESSAGE = 20

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Image types accepted inline by the Claude API. Everything else is sent as a file: an unlisted
 * image format would be rejected by the model.
 */
export const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

export interface AttachmentDto {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  createdAt: number
  /** True if the file will be passed to the model as an image rather than a path. */
  inlineImage: boolean
}

/**
 * A message can contain only attachments, hence optional text. It must contain at least one of
 * the two, otherwise an accidental send would create an empty turn with nothing for the agent
 * to answer.
 */
const messagePayloadSchema = z
  .object({
    /** Client-generated, replayed unchanged on network retries (I5). */
    clientMessageId: z.string().uuid(),
    text: z.string().default(''),
    attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
    /**
     * Paths mentioned with `@`, relative to the working directory, as they appear in the text.
     * The server resolves absolute paths and each CLI passes them in its own way.
     */
    mentions: z.array(z.string().min(1)).max(MAX_MENTIONS_PER_MESSAGE).default([]),
    /**
     * Skills invoked with `$`, by name only. Paths never come from the client: the runner
     * resolves names against its own published inventory and ignores unknown names, rather than
     * allowing arbitrary files to be fed to the CLI.
     */
    skills: z.array(z.string().min(1)).max(MAX_SKILLS_PER_MESSAGE).default([]),
  })
  .refine(
    (body) => body.text.trim().length > 0 || body.attachmentIds.length > 0,
    'Un message vide et sans pièce jointe n\'a rien à envoyer.',
  )

// Conversations

export const createConversationBodySchema = z.object({
  agent: agentKindSchema,
  config: agentConfigSchema,
  worktreeId: z.string().nullable().default(null),
  /**
   * Card handled by the conversation when launched from the board.
   *
   * The association is set here, on send, not when opening a draft: until something is sent, no
   * conversation exists to associate.
   */
  cardId: z.string().uuid().nullable().default(null),
  title: z.string().min(1).max(200).optional(),
  /**
   * First message, sent immediately after creation.
   *
   * The UI creates no conversation until something is written: otherwise every click would
   * leave an empty, untitled thread. Passing the message here makes the operation atomic rather
   * than risking a created conversation whose first send fails.
   */
  firstMessage: messagePayloadSchema.optional(),
})

/** Manual conversation order within a project, top to bottom. */
export const reorderConversationsBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
})

export const updateConversationBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    pinned: z.boolean(),
    archived: z.boolean(),
    /** Takes effect on the next message: the runner restarts in resume mode. */
    config: agentConfigSchema,
    /** Associates the conversation with a card in the same project, or detaches it with `null`. */
    cardId: z.string().uuid().nullable(),
  })
  .partial()

export const sendMessageBodySchema = messagePayloadSchema

/**
 * Steering the current turn. Same payload as a send: the message is identical; only when it is
 * taken into account changes.
 */
export const steerBodySchema = messagePayloadSchema

/**
 * Forks a conversation at a point in the thread.
 *
 * `throughSeq` is the last journal event retained in the branch. The cut is expressed in
 * events, not turns, because that is what the client sees; the server derives what each CLI
 * expects.
 */
export const forkConversationBodySchema = z.object({
  throughSeq: z.number().int().nonnegative(),
  title: z.string().min(1).max(200).optional(),
})

/**
 * Continues a conversation in another CLI.
 *
 * Target CLI and configuration, as at creation, plus the history selection's token budget
 * clamped to server limits. No first message: the new request is written in the continuation
 * after opening it, never mixed into transferred context.
 */
export const handoffConversationBodySchema = z.object({
  agent: agentKindSchema,
  config: agentConfigSchema,
  title: z.string().min(1).max(200).optional(),
  budgetTokens: z.number().int().positive().optional(),
})

/** What was transferred to a continuation, for display. */
export interface HandoffDto {
  fromConversationId: string
  throughSeq: number
  budgetTokens: number
  bytes: number
  text: string
  createdAt: number
}

export const permissionDecisionBodySchema = z.object({
  decision: z.enum(['allowed', 'denied']),
  scope: z.enum(['once', 'session', 'always']).default('once'),
})

/**
 * Answer to an agent's question.
 *
 * Values are free-form, not limited to suggested options: both CLIs accept a typed “other”
 * answer.
 */
export const questionAnswerBodySchema = z.object({
  status: z.enum(['answered', 'cancelled']),
  answers: z.record(z.string(), z.array(z.string())).default({}),
})

/**
 * Answer to an MCP elicitation. Only value shapes are validated here: the requesting MCP server
 * validates compliance with its own schema.
 */
export const elicitationAnswerBodySchema = z.object({
  action: elicitationActionSchema,
  content: elicitationContentSchema.default({}),
})

export const planDecisionBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  /**
   * How to proceed after approval: an option `id` from `plan.review_requested`. Null preserves
   * the current mode. Opaque here; validated by the adapter that offered the options.
   */
  followUpMode: z.string().nullable().default(null),
})

/**
 * The client reports how far it has read. The server never moves the cursor backwards: two tabs
 * on the same thread report different seq values, and the slower one must not mark content
 * unread after the other cleared it.
 */
export const markReadBodySchema = z.object({ seq: z.number().int().min(0) })

/**
 * Metrics for assessing a conversation's size without opening it.
 *
 * Read from the database rather than folded from the journal: the sidebar displays them for all
 * conversations at once, and folding every journal would cost a full-history read. Shared by
 * REST listings and status pushes, which must agree.
 */
export interface ConversationMetrics {
  /**
   * Main-thread turns, one per user message: marks on the navigation ruler. Agent messages are
   * excluded because each tool call produces one, which would count steps instead.
   *
   * A turn in thread segmentation, distinct from `turn.started`: they do not always coincide.
   */
  turnCount: number
  /** Journal size on disk, in bytes. */
  journalBytes: number
  /**
   * Context-window usage last reported by the CLI; null before any report. Separate from
   * cumulative tokens: it resets at every compaction.
   */
  context: { usedTokens: number; maxTokens: number } | null
  /** Model of the latest opened session; null before the first launch. */
  model: string | null
}

export interface ConversationDto {
  id: string
  projectId: string | null
  worktreeId: string | null
  /**
   * Card handled by this conversation, or null.
   *
   * Resolved on read rather than frozen like the origin: card titles can be corrected, and the
   * thread must show the current version.
   */
  card: CardLinkDto | null
  userId: string
  title: string
  /** True if the user renamed it: the CLI will no longer suggest a title. */
  titleSetByUser: boolean
  agent: AgentKind
  /** Original conversation if this is a fork; otherwise null. */
  forkedFromId: string | null
  /** Conversation this one continues in another CLI; otherwise null. */
  handoffFromId: string | null
  config: unknown
  status: ConversationStatus
  lastSeq: number
  /**
   * Last `seq` worth notifying the reader about. Always at most `lastSeq`: the journal also
   * advances for service writes that notify nobody.
   */
  lastNotableSeq: number
  /**
   * How far the calling account has read, like `isOwner`: derived from the requester, not the
   * conversation. Below `lastNotableSeq` means something relevant has happened since their last
   * visit.
   */
  lastReadSeq: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  metrics: ConversationMetrics
  pinned: boolean
  /**
   * Calling account's bookmark, like `lastReadSeq` and `isOwner`: derived from the requester,
   * not the conversation. Two accounts viewing the same shared thread need not share favorites.
   */
  favorite: boolean
  position: number
  archivedAt: number | null
  createdAt: number
  updatedAt: number
  isOwner: boolean
  /**
   * API token that launched the conversation; null when created in the UI.
   *
   * The label is frozen at creation rather than resolved on read: cleaning up tokens must not
   * erase a conversation's origin.
   */
  origin: { tokenId: string | null; label: string } | null
  /**
   * Scheduled task whose run opened this thread; null for ordinary conversations. The sidebar
   * uses it to group the thread under its task rather than in the main list.
   */
  scheduleId: string | null
}

export interface JournalPageDto {
  entries: { seq: number; ts: number; event: unknown }[]
  /**
   * Next-page cursor: last `seq` **read**, whether its event was returned, merged into another,
   * or discarded as superseded by later journal events. Page deltas are grouped by message, so
   * the last returned entry has its group's first-fragment `seq`, not the last one read; using
   * it as cursor would reread the page forever. A page can also contain no entries yet advance
   * the cursor.
   *
   * Optional because the web frontend can be replaced without a restart, unlike the server:
   * during deployment, this client may talk to a server unaware of it. The server always
   * returns it.
   */
  nextAfter?: number
  /** Latest seq known to the server, used as the WebSocket subscription cursor. */
  lastSeq: number
}

// Worktrees

export const createWorktreeBodySchema = z.object({
  /** Branch name. Also used as directory name, hence the restriction. */
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._\/-]+$/, 'Caractères autorisés : lettres, chiffres, . _ - /')
    // The name also builds a disk path: reject `..`
    // here, not only through git's incidental rejection.
    .refine((name) => !name.split('/').includes('..'), 'Le nom ne peut pas contenir « .. »')
    .refine((name) => !name.startsWith('/') && !name.endsWith('/'), 'Nom de branche invalide'),
  baseRef: z.string().min(1).default('HEAD'),
})

export interface WorktreeDto {
  id: string
  projectId: string
  name: string
  path: string
  baseRef: string
  createdAt: number
  /** Null if the directory disappeared from disk outside Sillage. */
  git: { branch: string; isDirty: boolean } | null
  /** Number of conversations using it, for the deletion warning. */
  conversationCount: number
}

/**
 * Worktree state relative to the project's default branch, from most urgent to least: missing,
 * uncommitted work absent from base, commits absent from base, branch merged but files left in the
 * tree (a forgotten file or a demo leftover, for the user to sort), nothing base does not already
 * have (ready for cleanup).
 */
export type WorktreeState = 'missing' | 'dirty' | 'unmerged' | 'leftovers' | 'merged'

/** File the tree holds beyond its last commit, as `git status` reports it. */
export interface WorktreeFileDto {
  path: string
  kind: 'modified' | 'deleted' | 'untracked'
}

/** How a conversation is associated with a worktree: its cwd or files it wrote there. */
export type WorktreeLink = 'worktree' | 'edited'

export interface WorktreeStatusDto {
  /** Null for a worktree known to git but not created by Sillage. */
  id: string | null
  /** Branch, or database entry name when the branch is missing. */
  name: string
  path: string
  branch: string | null
  /** True for a worktree created from the shell outside Sillage. */
  external: boolean
  state: WorktreeState
  /** Branch-only commits and base commits it lacks. */
  ahead: number
  behind: number
  /** Modified tracked files and untracked files. */
  modified: number
  untracked: number
  /** Merging into base would produce a conflict. */
  conflicts: boolean
  lastCommitAt: number | null
  lastEditAt: number | null
  /** First files beyond the last commit, enough to recognise them without opening the tree. */
  files: WorktreeFileDto[]
  /**
   * Identity of the files left in a `leftovers` tree, sent back to keep exactly what was shown:
   * any later change gives another value. Null in every other state.
   */
  fingerprint: string | null
  /** Files the user chose to keep after merging: the tree counts as merged while they stay unchanged. */
  kept: number
  conversations: { id: string; link: WorktreeLink }[]
}

export interface WorktreeStatusListDto {
  /** Comparison branch; null outside a repository or with no branches. */
  base: string | null
  computedAt: number
  /** False when returning the previous calculation's list while the next is running. */
  fresh: boolean
  worktrees: WorktreeStatusDto[]
}

/**
 * What “Clean up” would do to a worktree, read before confirmation: nothing disappears
 * silently; the confirmation lists what would be lost and stopped.
 */
export interface WorktreeCleanupPlanDto {
  path: string
  name: string
  branch: string | null
  state: WorktreeState
  /** Work lost with the tree: uncommitted changes, untracked files, branch-only commits. */
  modified: number
  untracked: number
  ahead: number
  /** True if the branch can be deleted: it exists and is not the base. */
  branchDeletable: boolean
  /** Still-active associated sessions to archive. */
  conversations: { id: string; title: string }[]
  /** Services and demos whose directory lies in the worktree. */
  services: { id: string; label: string; kind: 'app' | 'process' }[]
  terminals: number
  /** Unfinished card handled by an associated session. */
  card: { id: string; number: number; title: string } | null
}

/** Keep the leftovers of a merged tree; `fingerprint` must match the current one. */
export const worktreeKeepBodySchema = z.object({
  path: z.string().min(1),
  fingerprint: z.string().min(1),
})

export const worktreeCleanupBodySchema = z.object({
  path: z.string().min(1),
  deleteBranch: z.boolean().default(true),
  archiveSessions: z.boolean().default(true),
  stopServices: z.boolean().default(true),
})

export interface WorktreeCleanupResultDto {
  removed: boolean
  branchDeleted: boolean
  archived: number
  stopped: number
}

export interface DiffFileDto {
  path: string
  added: number
  removed: number
}

/** A commit on the current branch, as returned by `git log`. */
export interface CommitDto {
  /** Parents in Git order; the first continues the branch. */
  parents: string[]
  /** Full hash: used as the key and requested again for the diff. */
  hash: string
  shortHash: string
  subject: string
  author: string
  /**
   * Commit timestamp in milliseconds.
   *
   * An absolute date rather than git's relative age: `%cr` uses the server's language and
   * freezes at request time.
   */
  ts: number
  /**
   * References on this commit: local branches, remote branches, tags (`tag: v1.0`). What `%D`
   * returns, without the `HEAD -> ` arrow: the current commit is marked separately.
   */
  refs: string[]
}

export interface CommitListDto {
  /** Null if the working directory is not a git repository; empty if it has no commits. */
  commits: CommitDto[] | null
  /** True if older commits remain to be requested. */
  hasMore: boolean
}

/** What a commit changed, in the same shape as the working-directory diff. */
export interface CommitDiffDto {
  files: DiffFileDto[]
  patch: string
  truncated: boolean
}

export const commitListQuerySchema = z.object({
  all: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(2000).default(30),
  skip: z.coerce.number().int().min(0).default(0),
})

/**
 * A hash and nothing else: the reference goes on git's command line, where `--all` or `HEAD~5`
 * would not belong.
 */
export const commitHashSchema = z.string().regex(/^[0-9a-f]{7,40}$/)

// Claude Code sessions already on disk

/**
 * A session started with the Claude Code CLI in the project directory, not yet linked to a
 * Sillage conversation. Import does not copy it: Sillage records its native ID and rebuilds its
 * journal from the transcript, then each turn resumes that same CLI session.
 */
export interface ClaudeSessionDto {
  sessionId: string
  title: string
  firstPrompt: string | null
  gitBranch: string | null
  lastModified: number
}

export interface ClaudeSessionsDto {
  sessions: ClaudeSessionDto[]
}

/** Resync result: number of events recovered from the transcript. */
export interface ClaudeSyncDto {
  imported: number
}

// CLI capabilities

/** An effort level accepted by a model. The label comes from the adapter. */
export interface AgentEffortDto {
  value: string
  label: string
  hint: string | null
}

/**
 * A model reported by the installed CLI, in a shared shape. Nothing is hardcoded in Sillage:
 * CLI updates expose new models without rebuilding, and the UI builds the same pickers for all
 * of them.
 */
export interface AgentModelDto {
  /** ID to pass to the CLI: an alias (`sonnet`) or a full ID. */
  value: string
  displayName: string
  description: string
  /** Extra displayed detail (canonical ID behind an alias, etc.), when provided by the CLI. */
  hint: string | null
  isDefault: boolean
  /** Empty if the model does not support effort levels. */
  efforts: AgentEffortDto[]
  /** Fallback when the conversation's effort level does not exist on this model. */
  defaultEffort: string | null
  /** The model supports Claude Code fast mode. Always false for Codex. */
  supportsFastMode: boolean
}

/**
 * A sub-agent the CLI can launch, referenced as `@name` in a message. Built-ins (`Explore`,
 * `Plan`, etc.) and project agents (`.claude/agents/`) arrive through the same channel.
 */
export interface AgentInfoDto {
  name: string
  description: string
}

/**
 * Account-level fast mode availability, before any conversation: whether available and, if not,
 * why. `sdk_opt_in_required` is normal for an eligible account, since the session must request
 * the mode; it therefore means “available”.
 */
export interface FastModeAvailabilityDto {
  available: boolean
  /** Unavailability reason as named by the CLI; null when available. */
  reason: string | null
}

/**
 * Claude account type, as reported by the CLI.
 *
 * Determines what the UI may display: on subscriptions, CLI-calculated cost is an API
 * equivalent, not an actual charge. Quota describes the resource actually consumed.
 */
export interface ClaudeAccountDto {
  /** For example, “Claude Max”. Null for usage-based billing. */
  subscriptionType: string | null
  organization: string | null
  /** True if a subscription covers usage, making a monetary amount misleading. */
  billedBySubscription: boolean
}

/**
 * A Codex collaboration mode, as reported by `collaborationMode/list`. The displayed name comes
 * from the CLI: Sillage does not translate “Plan” into something else.
 */
export interface CodexModeDto {
  mode: CodexMode
  label: string
}

/**
 * Turn execution mode as named by the CLI: Codex collaboration mode or opencode primary agent
 * (`build`, `plan`, or a user-defined agent). `mode` is a string because opencode's list is
 * open-ended; `CodexModeDto` is the closed-set case.
 */
export interface AgentModeDto {
  mode: string
  label: string
  /** CLI-provided description, if any. */
  hint?: string | null
}

/** Response from `/api/agents/:agent/models`, with the same shape for every CLI. */
export interface AgentModelsDto {
  models: AgentModelDto[]
  /**
   * Collaboration modes (Codex) or primary agents (opencode); empty if unreported.
   */
  modes: AgentModeDto[]
  /** Account type when reported by the CLI (Claude); otherwise null. */
  account: ClaudeAccountDto | null
  /** CLI output styles (Claude); empty if none. */
  outputStyles: string[]
  /** Account fast-mode availability (Claude); null for CLIs without this concept. */
  fastMode: FastModeAvailabilityDto | null
  /** Named sub-agents the CLI can launch; empty if unreported. */
  agents: AgentInfoDto[]
  fetchedAt: number
}

/**
 * What Sillage finds for an agent's CLI on the machine.
 *
 * The screen uses this to avoid offering agents the server cannot launch: CLIs are no longer
 * bundled with releases, so absence is normal and must be visible before the first turn fails.
 *
 * `version` may be null even when the CLI exists: a binary that does not answer `--version`
 * remains usable, so reporting it missing would be wrong.
 */
export interface AgentAvailabilityDto {
  agent: AgentKind
  /** Configured name or path, shown when resolution fails. */
  binary: string
  /** False when configuration disables the agent: nothing was probed. */
  enabled: boolean
  installed: boolean
  /** True when installed by Sillage; false when found through the system PATH. */
  managed: boolean
  /** False for disabled CLIs or a custom executable that managed installation would not replace. */
  installable: boolean
  /** Absolute path actually launched; null when not found. */
  path: string | null
  version: string | null
  /** Why the agent is unavailable; null when available. */
  reason: 'disabled' | 'not_on_path' | 'not_executable' | null
  /** Version targeted by this Sillage release and used by installation. */
  preferredVersion: string
  install: CliInstallStateDto
}

/**
 * Current installation or latest failure for an agent.
 *
 * `idle` covers both “never attempted” and “finished”: successful installation is reflected by
 * `installed` and `version`, not here. A persistent “success” state would duplicate that
 * information and could contradict it.
 */
export type CliInstallStateDto =
  | { status: 'idle' }
  | { status: 'queued'; version: string; reason: 'sessions' | 'installation' }
  | {
      status: 'running'
      version: string
      /** Installation start time in milliseconds, used by the screen to derive elapsed time. */
      startedAt: number
      /**
       * Completed npm registry requests and the latest file. This is the only progress npm
       * exposes without a terminal: not a percentage, but enough to show activity.
       */
      fetched: number
      current: string | null
    }
  | { status: 'failed'; version: string; error: string; code?: string; params?: Record<string, string | number> }

/** Response from `/api/agents`. */
export interface AgentAvailabilityListDto {
  agents: AgentAvailabilityDto[]
}

// Directory explorer

export const browseQuerySchema = z.object({
  path: z.string().optional(),
  showHidden: z.coerce.boolean().default(false),
})

export const mkdirBodySchema = z.object({
  path: z.string(),
  name: z.string().min(1),
})

export interface FsEntryDto {
  name: string
  path: string
  /** The directory contains a .git: useful for spotting a project root. */
  isGitRepo: boolean
  /** Read denied: the entry is listed but cannot be entered. */
  readable: boolean
}

export interface FsListingDto {
  path: string
  /** null at the filesystem root. */
  parent: string | null
  entries: FsEntryDto[]
  isGitRepo: boolean
  /** Listing truncated: the directory contains more entries than the limit. */
  truncated: boolean
  /** Starting locations suggested in the UI. */
  roots: { label: string; path: string }[]
}

// Push notifications

/**
 * Notification payload as received by the service worker.
 *
 * Deliberately minimal: the service worker has no session and cannot fetch additional data.
 * Everything it displays must fit here.
 */
export interface PushPayload {
  title: string
  body: string
  /** Path opened on click, relative to the origin. */
  url: string
  /**
   * Groups notifications from one conversation: only one remains displayed instead of a stack
   * repeating the same information.
   */
  tag: string
  /**
   * What the notification announces, so the service worker can compose a title in the device
   * language; `title` remains the fallback.
   */
  kind?: 'permission' | 'question' | 'elicitation' | 'plan' | 'turnCompleted' | 'decision' | 'test'
  /** Pending decisions, for the installed app icon badge. */
  badge?: number
}

export const pushSubscribeBodySchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

export const pushUnsubscribeBodySchema = z.object({ endpoint: z.string().url() })

export interface PushStatusDto {
  /** Instance VAPID public key, required by the browser to subscribe. */
  publicKey: string
  /** True if this account already has at least one subscribed device. */
  subscribed: boolean
}

// Side-panel file explorer

/**
 * Entry git state. For directories, derived from contents: otherwise every directory would need
 * expanding to find changes.
 */
export const fileStateSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'untracked',
  'ignored',
])
export type FileState = z.infer<typeof fileStateSchema>

export const treeQuerySchema = z.object({
  /** Relative to the working directory. Empty for the root. */
  path: z.string().max(1024).default(''),
})

export interface TreeEntryDto {
  name: string
  /** Path relative to the working directory, the UI's only identifier. */
  path: string
  isDirectory: boolean
  /** Absent if the file is unchanged or the workspace is not a repository. */
  state?: FileState
}

export interface TreeListingDto {
  path: string
  entries: TreeEntryDto[]
  /** False outside a git repository: the explorer then displays no colors. */
  versioned: boolean
  /**
   * Absolute working-directory path. The explorer knows only relative paths, but “Copy path”
   * must return a shell-usable path.
   */
  root: string
}

export const treeSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
})

export interface TreeSearchDto {
  entries: TreeEntryDto[]
  /**
   * True when traversal stopped before seeing everything; otherwise searches in large
   * repositories would show “no results” when matches simply lay further on.
   */
  truncated: boolean
}

/**
 * An entry name and nothing else.
 *
 * Reject separators here rather than later: a name is a name, and allowing `../x` would make
 * containment depend solely on path normalization. `.` and `..` are rejected for the same
 * reason.
 */
const entryNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('/') && !name.includes('\\'), {
    message: 'Un nom ne peut pas contenir de séparateur de chemin.',
  })
  .refine((name) => name !== '.' && name !== '..', { message: 'Nom réservé.' })

export const createEntryBodySchema = z.object({
  /** Parent directory relative to the working directory. Empty for the root. */
  parent: z.string().max(1024).default(''),
  name: entryNameSchema,
  kind: z.enum(['file', 'directory']),
})

/**
 * Rename and move are the same operation: only the destination path changes. Separate routes
 * would force the UI to decide which to call from the path, something the server already
 * handles better.
 */
export const moveEntryBodySchema = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
})

export const deleteEntryBodySchema = z.object({ path: z.string().min(1).max(1024) })

/**
 * Copies an entry into a directory. Only the destination directory is supplied: the server
 * chooses the name and adds “copy” rather than overwriting, making an in-place copy a
 * duplicate.
 */
export const copyEntryBodySchema = z.object({
  from: z.string().min(1).max(1024),
  toParent: z.string().max(1024).default(''),
})

/**
 * Entries combined into one archive. Enough for a manual selection; beyond this, the URL
 * carrying them would exceed HTTP server limits.
 */
export const MAX_ARCHIVE_PATHS = 200

/**
 * Entries to download as `.zip`, in a repeated parameter (`?path=a&path=b`): downloads use a
 * link, hence a bodyless `GET`.
 */
export const archiveQuerySchema = z.object({
  path: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .pipe(z.array(z.string().min(1).max(1024)).min(1).max(MAX_ARCHIVE_PATHS)),
})

/**
 * Size limit for files dropped into the explorer.
 *
 * Unlike attachments, which enter model context, dropped files only land on workspace disk,
 * where asset packs and project archives belong. Content is streamed, so size costs no memory;
 * this limit merely prevents an accidentally dropped directory from filling the server disk.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024

/**
 * Files accepted from a single drop. A directory dropped onto the tree may contain tens of
 * thousands (an accidental `node_modules`): above this threshold, reject the whole upload
 * rather than starting and abandoning it.
 */
export const MAX_UPLOAD_FILES = 200

/** Dropped file destination, relative to the working directory. */
export const uploadQuerySchema = z.object({ path: z.string().min(1).max(1024) })

// Panel files

/** Beyond this, the editor slows down and content becomes unreadable: reject explicitly. */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024

/**
 * Extensions rendered as images rather than text, with their served types. A closed, shared
 * list: the server reads the response type and the client decides whether to display an image.
 * Content-based guessing could render arbitrary binaries in an `img` tag.
 */
export const VIEWABLE_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
}

/**
 * Binary documents displayed by the browser itself in a frame.
 *
 * Separate from images because serving differs: a strict security policy makes images inert,
 * whereas PDFs go to the built-in viewer, which needs its own resources to render.
 */
export const VIEWABLE_DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
}

/**
 * Audio and video played with native browser elements.
 *
 * The server streams them with `Range` request support: without it, seeking would not work and
 * a video hundreds of MB long would be read entirely before playback starts.
 */
export const VIEWABLE_MEDIA_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
}

export function isAudioType(type: string): boolean {
  return type.startsWith('audio/')
}

/**
 * 3D models rendered in the browser by a WebGL viewer.
 *
 * The browser never interprets these files directly; scripts read them. Formats without an
 * official type are served as `octet-stream`, ensuring direct navigation downloads rather than
 * displays them.
 *
 * `bin` and `mtl` cannot open alone: they are supporting resources for split `gltf` or `obj`
 * models, fetched beside the main file by the viewer.
 */
export const VIEWABLE_MODEL_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'application/octet-stream',
  mtl: 'application/octet-stream',
  fbx: 'application/octet-stream',
  stl: 'application/octet-stream',
  bin: 'application/octet-stream',
}

/** Extensions the 3D viewer can open as a main file. */
export const OPENABLE_MODEL_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl'])

export const filePathQuerySchema = z.object({ path: z.string().min(1).max(1024) })

/**
 * Paths the thread checks for existing files so only valid ones become clickable.
 *
 * Batched per message: a message commonly mentions ten paths, and that many round trips just to
 * display links would cost more than the links are worth. The limit follows file-search
 * `MAX_RESULTS` for the same reason.
 */
export const filesExistBodySchema = z.object({
  paths: z.array(z.string().min(1).max(1024)).max(50),
})

export interface FileContentDto {
  path: string
  content: string
  /**
   * File fingerprint on disk at read time (size and modification time). Returned on save to
   * detect an agent writing the file in the meantime.
   */
  fingerprint: string
  /** Lowercase extension used by the UI to choose syntax highlighting. */
  extension: string
}

export const fileWriteBodySchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
  /**
   * Fingerprint received on read. `null` forces the write: an explicit overwrite choice made
   * after showing a conflict.
   */
  fingerprint: z.string().nullable(),
})

// File modification by a tool call

export const editDiffQuerySchema = z.object({ path: z.string().min(1).max(1024) })

/**
 * What a tool call did to a file, reconstructed from the native payload retained in the
 * journal.
 *
 * Three forms, because the two CLIs report different amounts:
 * - `patch`: a unified diff, complete for Codex, limited to the replaced excerpt for a targeted
 * Claude edit (`partial`).
 * - `content`: written contents without a comparison point. A full Claude write does not reveal
 * previous contents; inventing them would be worse.
 * - `unavailable`: nothing usable, with a displayed reason rather than an empty space.
 */
/**
 * Full tool-call output, requested when replay returned only a preview. `output` preserves the
 * exact journal shape, string or content blocks, so readable views and image rendering can
 * still consume it.
 */
export interface ToolOutputDto {
  toolCallId: string
  output: unknown
}

export interface EditDiffDto {
  path: string
  kind: 'patch' | 'content' | 'unavailable'
  patch: string
  content: string
  /** True when the diff covers only an excerpt: line numbers are relative to it. */
  partial: boolean
  reason: string | null
}

// Search

/** Messages returned per query: the palette displays no more than this. */
export const SEARCH_RESULT_LIMIT = 20

/** Content search does not run below this character count. */
export const SEARCH_MIN_QUERY = 3

/**
 * Bounds of a match within an excerpt.
 *
 * Matches arrive bracketed by two control characters rather than markup: rendering
 * database-supplied HTML would require trusting it, whereas these bounds can be split as plain
 * text.
 */
export const SEARCH_MARK_OPEN = '\u0001'
export const SEARCH_MARK_CLOSE = '\u0002'

export interface SearchMessageDto {
  conversationId: string
  projectId: string | null
  conversationTitle: string
  agent: AgentKind
  /** Message position in the journal, used to open the thread at the right place. */
  seq: number
  role: 'user' | 'assistant'
  ts: number
  excerpt: string
}

// MCP servers

export const createMcpServerBodySchema = z.object({
  name: mcpServerNameSchema,
  enabled: z.boolean().default(true),
  transport: mcpTransportSchema,
})

export const updateMcpServerBodySchema = z
  .object({
    name: mcpServerNameSchema,
    enabled: z.boolean(),
    transport: mcpTransportSchema,
  })
  .partial()

export interface McpServerListDto {
  servers: McpServer[]
  /**
   * The instance mounts Sillage's MCP server in conversations.
   *
   * Included in this list rather than a capabilities endpoint: it answers the same question as
   * registered servers at the same time, and the composer needs both answers for one control.
   * When false, the entry disappears rather than remaining disabled.
   */
  sillageServer: boolean
}

// Errors

/** All API errors share this shape for uniform UI display. */
/**
 * Single API error shape.
 *
 * The UI translates `code`; `params` contains interpolation values; `message` is the
 * server-written English fallback, displayed verbatim when the catalog lacks the code. This
 * ensures a missing code still shows a readable sentence rather than an identifier.
 */
export interface ApiError {
  error: {
    code: string
    message: string
    params?: Record<string, string | number>
  }
}
