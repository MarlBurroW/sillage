import { z } from 'zod'
import { elicitationContentSchema, elicitationFieldSchema } from './elicitation.js'
import { mcpServerStatusSchema } from './mcp.js'
import { slashCommandSchema } from './commands.js'
import { agentSkillSchema } from './skills.js'
import { toolPresentationSchema } from './tools.js'

/**
 * Normalized event schema (spec invariant I3).
 *
 * Each CLI adapter translates its native stream into these events. The frontend knows only this
 * schema, regardless of the underlying CLI. Raw native payloads are retained separately in
 * `events.raw` for specialized renderers.
 */

export const agentKindSchema = z.enum(['claude', 'codex', 'opencode', 'grok'])
export type AgentKind = z.infer<typeof agentKindSchema>

export const planStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

export const eventBodyRefSchema = z.object({
  seq: z.number().int().positive(),
  field: z.enum(['input', 'output', 'patch']),
  block: z.number().int().nonnegative().optional(),
})
export type EventBodyRef = z.infer<typeof eventBodyRefSchema>

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('image'), mimeType: z.string(), url: z.string(), width: z.number().positive().optional(), height: z.number().positive().optional() }),
  /**
   * Attachment that cannot display inline. The path passed to the agent is absent here: the
   * thread shows the file, not its location on server disk.
   */
  z.object({
    type: z.literal('file'),
    name: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    url: z.string(),
  }),
  z.object({
    type: z.literal('tool_use'),
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
    inputRef: eventBodyRefSchema.optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    output: z.unknown(),
    outputRef: eventBodyRefSchema.optional(),
    isError: z.boolean(),
  }),
])
export type ContentBlock = z.infer<typeof contentBlockSchema>

/**
 * Parent tool call for events from a sub-agent: the call that launched it. Null for main-agent
 * output.
 *
 * Defaults to null rather than being required: the journal is replayed indefinitely (I2), and
 * events written before this field existed must remain readable.
 */
const parentToolCallIdSchema = z.string().nullable().default(null)

/** An option offered by the CLI in a permission request. */
export const permissionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.enum(['once', 'session', 'always']),
  behavior: z.enum(['allow', 'deny']),
})
export type PermissionOption = z.infer<typeof permissionOptionSchema>

/** A choice offered for an agent question. */
export const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  /** Optional preview: mockup, code excerpt or configuration example. */
  preview: z.string().nullable().default(null),
})
export type QuestionOption = z.infer<typeof questionOptionSchema>

/**
 * An agent question, normalized across both CLIs.
 *
 * Claude uses `AskUserQuestion`, Codex uses `item/tool/requestUserInput`. Both describe the
 * same thing: a title, options and how to answer.
 */
export const agentQuestionSchema = z.object({
  /** Answer key. Codex supplies it; Claude uses the title itself. */
  id: z.string(),
  header: z.string(),
  question: z.string(),
  /** Multiple options may be selected together. */
  multiSelect: z.boolean().default(false),
  /** Free-form answers are accepted alongside suggested options. */
  allowOther: z.boolean().default(false),
  /** Input must not be displayed in cleartext. */
  secret: z.boolean().default(false),
  /** Empty when only a free-form answer is expected. */
  options: z.array(questionOptionSchema).default([]),
})
export type AgentQuestion = z.infer<typeof agentQuestionSchema>

/**
 * A continuation option after plan approval, offered by the adapter.
 *
 * Like `permission.requested.suggestions`: the CLI, not the shared schema, knows which modes it
 * accepts next. `id` is opaque to the journal and UI, meaningful only to the emitting adapter
 * (a permission mode for Claude).
 */
export const planFollowUpOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string().default(''),
})
export type PlanFollowUpOption = z.infer<typeof planFollowUpOptionSchema>

/**
 * Work continuing outside the turn: a workflow, background sub-agent or command, or service
 * monitoring.
 *
 * `kind` stays a free-form string rather than an enum: CLIs add kinds across versions and fall
 * back to raw discriminants for unnamed ones. The UI translates known kinds and displays
 * unknown ones verbatim rather than rejecting an event merely for being new.
 */
export const backgroundTaskSchema = z.object({
  id: z.string(),
  kind: z.string(),
  description: z.string(),
})
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>

/**
 * A scheduled task that reopens the session itself: `/loop`, at a fixed interval or an
 * agent-chosen cadence. Both use the same CLI registry; the latter registers as a one-shot task
 * rearmed each turn.
 *
 * `schedule` is a five-field cron expression interpreted in the server's timezone. It does not
 * give the next run time: CLI jitter can reach half the interval, so display cadence and last
 * observed wakeup rather than a misleading countdown.
 *
 * The CLI truncates `prompt` to 1000 characters with an end marker.
 */
export const loopSchema = z.object({
  id: z.string(),
  schedule: z.string(),
  recurring: z.boolean(),
  prompt: z.string(),
})
export type Loop = z.infer<typeof loopSchema>

/** A file changed by a turn between the two snapshots. Null for binary files. */
export const checkpointFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable().default(null),
  kind: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'typechange']),
  added: z.number().nullable().default(null),
  removed: z.number().nullable().default(null),
})
export type CheckpointFile = z.infer<typeof checkpointFileSchema>

export const sillageEventSchema = z.discriminatedUnion('type', [
  // Lifecycle
  z.object({
    type: z.literal('session.started'),
    agent: agentKindSchema,
    agentSessionId: z.string(),
    model: z.string(),
    cwd: z.string(),
    tools: z.array(z.string()),
  }),
  z.object({
    type: z.literal('session.ended'),
    reason: z.enum(['completed', 'interrupted', 'error']),
  }),
  z.object({ type: z.literal('turn.started') }),
  z.object({
    type: z.literal('turn.completed'),
    stopReason: z.string(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    /**
     * Most CLI context comes through cache: counting only `inputTokens` produces totals
     * unrelated to actual consumption (2 versus 33,231 on an observed turn). Defaults to 0 for
     * events journaled before these fields existed.
     */
    cacheCreationTokens: z.number().default(0),
    cacheReadTokens: z.number().default(0),
  }),

  // Content
  z.object({
    type: z.literal('message.started'),
    messageId: z.string(),
    role: z.enum(['user', 'assistant']),
  }),
  z.object({
    type: z.literal('message.delta'),
    messageId: z.string(),
    text: z.string(),
    parentToolCallId: parentToolCallIdSchema,
  }),
  /**
   * One `messageId` can receive successive `message.completed` events: CLIs deliver assistant
   * messages in pieces (reasoning, then tool calls). Rendering folds append blocks rather than
   * replacing them.
   */
  z.object({
    type: z.literal('message.completed'),
    messageId: z.string(),
    role: z.enum(['user', 'assistant']),
    blocks: z.array(contentBlockSchema),
    parentToolCallId: parentToolCallIdSchema,
  }),
  z.object({
    type: z.literal('thinking.delta'),
    messageId: z.string(),
    text: z.string(),
    parentToolCallId: parentToolCallIdSchema,
  }),
  /**
   * Size of ongoing reasoning in estimated tokens.
   *
   * Accompanies `thinking.delta` frame by frame when reasoning is exposed, and replaces it
   * entirely when hidden: the stream otherwise cannot distinguish a thinking agent from a stuck
   * one, so this counter is its only sign of life.
   *
   * `estimatedTokens` is a CLI estimate reset for every reasoning block: it animates an
   * indicator, not billing, which only `turn.completed` finalizes.
   *
   * No message or thread ID: the CLI attaches neither; this progress belongs to the turn, not a
   * bubble.
   */
  z.object({
    type: z.literal('thinking.progress'),
    estimatedTokens: z.number(),
  }),

  // Tools
  z.object({
    type: z.literal('tool.started'),
    toolCallId: z.string(),
    name: z.string(),
    presentation: toolPresentationSchema.optional(),
    input: z.unknown(),
    inputRef: eventBodyRefSchema.optional(),
    parentToolCallId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('tool.output_delta'),
    toolCallId: z.string(),
    chunk: z.string(),
  }),
  z.object({
    type: z.literal('tool.input_updated'),
    toolCallId: z.string(),
    name: z.string().optional(),
    presentation: toolPresentationSchema.optional(),
    input: z.unknown(),
    inputRef: eventBodyRefSchema.optional(),
  }),
  z.object({
    type: z.literal('tool.completed'),
    toolCallId: z.string(),
    output: z.unknown(),
    outputRef: eventBodyRefSchema.optional(),
    isError: z.boolean(),
    durationMs: z.number(),
    /**
     * Actual output size, present only when `output` was omitted. History replay removes large
     * outputs to avoid transferring unread megabytes; the tool-call card requests the full body
     * when opened. Also used by live connections that opt into body references.
     */
    outputBytes: z.number().optional(),
  }),

  // Interaction required
  z.object({
    type: z.literal('permission.requested'),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    suggestions: z.array(permissionOptionSchema),
    /**
     * Labels written by the CLI itself. They describe the action better than text reconstructed
     * from a tool name, which lacks context (path outside allowed directories, triggered rule,
     * requested scope).
     *
     * Nullable and optional: the journal is replayed indefinitely (I2), so events written
     * before these fields existed must remain readable.
     */
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('permission.resolved'),
    requestId: z.string(),
    decision: z.enum(['allowed', 'denied', 'expired']),
    scope: z.enum(['once', 'session', 'always']),
    decidedBy: z.string().nullable(),
  }),

  // Agent questions
  z.object({
    type: z.literal('question.requested'),
    requestId: z.string(),
    questions: z.array(agentQuestionSchema),
    /** Absent in older journals: the question then blocks the turn. */
    blocking: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('question.resolved'),
    requestId: z.string(),
    status: z.enum(['answered', 'cancelled', 'expired']),
    /** Selected answers by question ID. */
    answers: z.record(z.string(), z.array(z.string())).default({}),
    decidedBy: z.string().nullable(),
  }),

  /**
   * Message written while a turn is already running.
   *
   * Not sent to the CLI immediately: messages pushed mid-turn mix into that turn's context, as
   * observed on the installed CLI (the second reply appeared before the first finished, then
   * appeared again). The queue therefore lives server-side, with these two events making it
   * visible.
   */
  z.object({
    type: z.literal('message.queued'),
    queueId: z.string(),
    text: z.string(),
    /** Attachment count, displayed without exposing their contents. */
    attachmentCount: z.number().default(0),
  }),
  z.object({
    type: z.literal('message.dequeued'),
    queueId: z.string(),
    /**
     * `sent`: the message goes to the CLI and becomes a normal thread message.
     * `steered`: also sent, but into the current turn rather than the next.
     */
    reason: z.enum(['sent', 'steered', 'cancelled', 'expired']),
  }),

  /**
   * A message from another session that Sillage has not delivered.
   *
   * The relay wakes idle sessions to deliver messages, unless an exchange loops or the
   * recipient has been woken too often unattended. It then holds the message; these two events
   * make that visible so a person can deliver or discard it instead of leaving it silently
   * waiting. `text` is the full envelope; see `parseSessionMessage`.
   */
  z.object({
    type: z.literal('session_message.held'),
    messageId: z.string(),
    text: z.string(),
    reason: z.enum(['loop', 'rate']),
  }),
  z.object({
    type: z.literal('session_message.released'),
    messageId: z.string(),
    /** `delivered` sent to the CLI, `read` read by the tool, `discarded` dismissed, `expired` too old. */
    reason: z.enum(['delivered', 'read', 'discarded', 'expired']),
  }),

  // Input requested by an MCP server (elicitation/create)
  z.object({
    type: z.literal('elicitation.requested'),
    requestId: z.string(),
    /** Requesting MCP server, displayed because it is untrusted. */
    serverName: z.string(),
    /**
     * `form` requests input, `url` asks to open a page (authentication). Codex's third mode,
     * `openai/form`, is normalized as a form here.
     */
    mode: z.enum(['form', 'url']),
    message: z.string(),
    /** Populated only in `url` mode. */
    url: z.string().nullable().default(null),
    fields: z.array(elicitationFieldSchema).default([]),
    title: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('elicitation.resolved'),
    requestId: z.string(),
    /** `expired` does not exist in MCP: it closes an unanswered request. */
    status: z.enum(['accept', 'decline', 'cancel', 'expired']),
    content: elicitationContentSchema.default({}),
    decidedBy: z.string().nullable(),
  }),

  // Plan approval before execution
  z.object({
    type: z.literal('plan.review_requested'),
    requestId: z.string(),
    /** The plan in markdown, as proposed by the agent. */
    plan: z.string(),
    /**
     * Post-approval continuations supplied by the adapter. Defaults to empty for older journal
     * events: the UI then offers approval without changing modes.
     */
    followUpOptions: z.array(planFollowUpOptionSchema).default([]),
  }),
  z.object({
    type: z.literal('plan.review_resolved'),
    requestId: z.string(),
    decision: z.enum(['approved', 'rejected', 'expired']),
    /**
     * Continuation selected on approval: a suggested option's `id`. Distinguishes “approve and
     * keep asking” from “approve and allow writes”. Opaque here: the emitting adapter validates
     * it; the shared schema need not know a CLI's permission modes.
     */
    followUpMode: z.string().nullable().default(null),
    decidedBy: z.string().nullable(),
  }),

  /**
   * Context summarization has started.
   *
   * Without this marker, compaction looks like an ordinary turn: the agent appears to think
   * while rewriting its memory, which can take much longer than a reply and produces none.
   *
   * Neither CLI reports numeric progress: the event says compaction is underway, all that can
   * be asserted.
   */
  z.object({ type: z.literal('context.compaction_started') }),

  /**
   * The agent modified a workspace file.
   *
   * A normalized event instead of client-side inference from tool names, as invariant I3
   * requires: CLIs report this differently (Claude `Write`/`Edit` tools, Codex `fileChange`
   * items). Edit history can thus be derived solely from the journal, replayed identically for
   * both.
   *
   * `toolCallId` associates the edit with its originating call so history can link back to the
   * thread.
   */
  z.object({
    type: z.literal('file.edited'),
    toolCallId: z.string(),
    /** Relative to the working directory when inside it; otherwise absolute. */
    path: z.string(),
    action: z.enum(['created', 'modified', 'deleted']),
  }),

  /**
   * Context has just been summarized.
   *
   * Journaled because nothing else reveals it: the thread loses no messages, but the agent's
   * memory changed. Without a marker, replies ignoring earlier details seem inexplicable.
   *
   * `preTokens` and `postTokens` are nullable: Claude supplies them, whereas Codex's item has
   * only an ID. Inventing a number would be worse than omitting it.
   */
  z.object({
    type: z.literal('context.compacted'),
    trigger: z.enum(['manual', 'auto', 'unknown']),
    preTokens: z.number().nullable().default(null),
    postTokens: z.number().nullable().default(null),
  }),

  /**
   * Active background work changed: a workflow started, a background command finished, or a
   * sub-agent moved to the background.
   *
   * Replacement, not incremental, semantics: every event carries the complete list, replacing
   * display state rather than pairing events. Unlike the rest of the journal, starts and ends
   * need not match; missing an event cannot leave an indicator permanently active.
   *
   * Otherwise a workflow runs for minutes with no indication: the turn ends, the thread becomes
   * idle, yet files change before the user's eyes in a supposedly inactive session.
   */
  z.object({
    type: z.literal('background.updated'),
    tasks: z.array(backgroundTaskSchema),
  }),

  /**
   * The session's MCP inventory changed: a server connected, failed or requests authentication.
   *
   * Same replacement semantics as `background.updated`: the CLI publishes all server states
   * together, never a delta. The list includes servers from CLI files marked `external`,
   * because users experience those failures too and must see them.
   *
   * Otherwise a misconfigured server fails silently: the agent simply lacks the expected tool,
   * indistinguishable from a model choosing not to use it.
   */
  z.object({
    type: z.literal('mcp.updated'),
    servers: z.array(mcpServerStatusSchema),
  }),

  /**
   * Slash commands recognized by the CLI for this session.
   *
   * Same replacement semantics as `mcp.updated`: the CLI republishes the whole list whenever it
   * changes, including during a session when a skill is discovered in a subdirectory.
   *
   * Already limited to commands Sillage can offer: filtering happens at the source, where the
   * CLI is known.
   */
  z.object({
    type: z.literal('commands.updated'),
    commands: z.array(slashCommandSchema),
  }),

  /**
   * Skills the CLI makes available to the session, referenced with `$`.
   *
   * Same replacement semantics and volatility as `commands.updated`: the CLI watches skill
   * files and reports changes. Published only by Codex; Claude exposes skills among slash
   * commands.
   */
  z.object({
    type: z.literal('skills.updated'),
    skills: z.array(agentSkillSchema),
  }),

  /**
   * Loops armed for this session, sampled at the end of every turn.
   *
   * Same replacement semantics as `background.updated`, for an even stronger reason: the CLI
   * announces neither loop creation nor completion, only answering list requests. An expired
   * loop disappears without an event; only the next sample removes it.
   *
   * Otherwise a self-waking conversation looks finished, and its new turn appears
   * user-authored.
   */
  z.object({
    type: z.literal('loops.updated'),
    loops: z.array(loopSchema),
  }),

  /**
   * An instruction entered the session without Sillage sending it: the CLI reinjected it,
   * usually for a due loop.
   *
   * Recognized because the CLI delivers text, while Sillage messages are always blocks and CLI
   * messages are tool results. This drives loop iteration counts because the CLI supplies no
   * counter.
   */
  z.object({
    type: z.literal('prompt.injected'),
    text: z.string(),
  }),

  /**
   * The CLI just registered a job.
   *
   * Adds what the state list omits: the originating tool call. It distinguishes a sub-agent
   * already followed in the thread from work no longer being watched, although both appear in
   * the same list.
   */
  z.object({
    type: z.literal('task.started'),
    taskId: z.string(),
    /** Null for work launched directly by the harness without a tool. */
    toolCallId: z.string().nullable().default(null),
    kind: z.string(),
    description: z.string(),
  }),

  /**
   * A job made progress.
   *
   * Emitted on every tool call in that job, enough to describe activity: an agent making no
   * calls is thinking, so the latest tool remains the most accurate description of its work.
   *
   * `activity` is the CLI's description of the present moment, not a cumulative log: each event
   * replaces the previous one.
   */
  z.object({
    type: z.literal('task.progress'),
    taskId: z.string(),
    activity: z.string(),
    lastTool: z.string().nullable().default(null),
    toolUses: z.number(),
    totalTokens: z.number(),
    durationMs: z.number(),
  }),

  /**
   * A job stopped, with its outcome.
   *
   * `summary` is the CLI's report. For work followed in the thread, it duplicates the tool
   * result; for background work, it is the only answer to “what did it do meanwhile?”, since
   * the state list merely removes it.
   */
  z.object({
    type: z.literal('task.completed'),
    taskId: z.string(),
    status: z.enum(['completed', 'failed', 'stopped']),
    summary: z.string(),
    durationMs: z.number().nullable().default(null),
    /** Maintenance work the CLI asks not to display in the thread. */
    ambient: z.boolean().default(false),
  }),

  // Metadata
  z.object({
    type: z.literal('agent.notice'),
    /** Stable identifier for replacing repeated state in rendering. */
    id: z.string().optional(),
    code: z.string(),
    message: z.string(),
    level: z.enum(['info', 'warning']),
    /** Collapsible details, also useful for events from newer CLIs. */
    details: z.unknown().optional(),
  }),
  /**
   * Next message predicted by the CLI, once per turn after `result`.
   *
   * Replaced, never appended: a suggestion applies only to the next turn and is cleared as soon
   * as any message is sent.
   */
  z.object({
    type: z.literal('suggestion.updated'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('plan.updated'),
    items: z.array(z.object({ text: z.string(), status: planStatusSchema })),
  }),
  /**
   * `costUsd` is the API-equivalent cost calculated by the CLI. On subscription accounts it is
   * not an actual charge: `rateLimit` describes the consumed resource. The UI chooses which to
   * display according to the account.
   */
  z.object({
    type: z.literal('usage.updated'),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    /**
     * The two fields below are tolerant: the journal replays indefinitely (invariant I2), so
     * events predating a field must remain readable. Without these defaults, older
     * `usage.updated` events produced `NaN`.
     *
     * Context-window usage determines when a conversation needs compaction, independently of
     * billing quota.
     */
    context: z
      .object({
        usedTokens: z.number(),
        maxTokens: z.number(),
        /** From 0 to 1, as calculated by the CLI when provided. */
        ratio: z.number(),
      })
      .nullable()
      .optional(),
    rateLimit: z
      .object({
        type: z.string(),
        status: z.enum(['allowed', 'allowed_warning', 'rejected']).default('allowed'),
        /** Consumed quota fraction, from 0 to 1. Absent if not reported by the CLI. */
        utilization: z.number().nullish().default(null),
        /**
         * Window reset time in milliseconds. Older events store seconds: any timestamp below
         * 1e12 predates 2001, so must be seconds. Conversion is idempotent.
         */
        resetsAt: z
          .number()
          .nullish()
          .default(null)
          .transform((value) =>
            value === null || value === undefined ? null : value < 1e12 ? value * 1000 : value,
          ),
      })
      .nullable()
      .optional(),
  }),
  /**
   * Turn checkpoints: workspace state captured before and after.
   *
   * Two events because these are distinct moments: `checkpoint.started` precedes the user
   * message; `checkpoint.completed` arrives after the final snapshot, after `turn.completed`
   * and possibly the next message. Their key links them and identifies the snapshot's git refs.
   */
  z.object({
    type: z.literal('checkpoint.started'),
    key: z.string(),
  }),
  z.object({
    type: z.literal('checkpoint.completed'),
    key: z.string(),
    /** `failed`: the final snapshot could not be captured; `reason` explains why. */
    status: z.enum(['ready', 'failed']),
    reason: z.string().nullable().default(null),
    files: z.array(checkpointFileSchema).default([]),
    /** True when the list was truncated: the full diff remains available through the API. */
    truncated: z.boolean().default(false),
    /** Excluded files introduced by a pull, merge or rebase during the turn. */
    excluded: z.number().default(0),
  }),
  /** Workspace restored to its state before this turn at the user's request. */
  z.object({
    type: z.literal('checkpoint.restored'),
    key: z.string(),
    written: z.number(),
    deleted: z.number(),
  }),
  z.object({
    type: z.literal('diff.updated'),
    /** Native unified diff, when provided. */
    patch: z.string().optional(),
    patchRef: eventBodyRefSchema.optional(),
    files: z.array(
      z.object({ path: z.string(), added: z.number(), removed: z.number() }),
    ),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }),
])

export type SillageEvent = z.infer<typeof sillageEventSchema>
export type SillageEventType = SillageEvent['type']

/** An event read from the journal: payload plus position and timestamp. */
export interface JournalEntry {
  conversationId: string
  seq: number
  ts: number
  event: SillageEvent
}
