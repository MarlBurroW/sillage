import type { ConversationRow } from '@sillage/db'
import {
  parseAgentConfig,
  type SillageEvent,
  type TaskActivityDto,
  type TaskDto,
  type TaskPendingDto,
  type TaskSummaryDto,
} from '@sillage/protocol'
import type { EventLog } from '../../events/event-log.js'

/**
 * Events describing a conversation's current state. Excludes token-level deltas,
 * which add nothing beyond the tool call producing them.
 */
const DIGEST_TYPES = [
  'tool.started',
  'tool.completed',
  'message.completed',
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'plan.review_requested',
  'plan.review_resolved',
  'elicitation.requested',
  'elicitation.resolved',
]

/**
 * Recent entry limit sufficient to describe the present state.
 *
 * An ordinary turn fits comfortably. Current tool calls and the last message
 * should be newer than this bound unless a conversation has run hundreds of
 * tools without speaking; return `null` rather than a stale value in that case.
 */
const DIGEST_WINDOW = 300

const PROMPT_KIND_BY_TYPE: Record<string, TaskPendingDto['kind'] | undefined> = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'plan.review_requested': 'plan',
  'elicitation.requested': 'elicitation',
}

const RESOLVED_TYPES = new Set([
  'permission.resolved',
  'question.resolved',
  'plan.review_resolved',
  'elicitation.resolved',
])

/** Assistant message text with reasoning and tool blocks removed. */
function messageText(event: Extract<SillageEvent, { type: 'message.completed' }>): string {
  return event.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

interface Digest {
  activity: TaskActivityDto | null
  lastMessage: { text: string; at: number } | null
  pending: TaskPendingDto | null
}

/**
 * Folds recent journal entries into a readable state.
 *
 * Reads newest first and stops at the first answer to each question, keeping
 * the view bounded instead of replaying the full history on every read.
 */
function digest(log: EventLog, conversationId: string): Digest {
  const entries = log.latest(conversationId, DIGEST_TYPES, DIGEST_WINDOW)

  const completedToolCalls = new Set<string>()
  const resolvedRequests = new Set<string>()
  let activity: TaskActivityDto | null = null
  let lastMessage: { text: string; at: number } | null = null
  let pending: TaskPendingDto | null = null

  for (const entry of entries) {
    const event = entry.event

    if (event.type === 'tool.completed') {
      completedToolCalls.add(event.toolCallId)
      continue
    }
    if (event.type === 'tool.started') {
      if (activity || completedToolCalls.has(event.toolCallId)) continue
      activity = {
        toolCallId: event.toolCallId,
        toolName: event.name,
        startedAt: entry.ts,
        nested: event.parentToolCallId !== null,
      }
      continue
    }
    if (event.type === 'message.completed') {
      // Subagent messages are not the conversation's response: exposing them would
      // mistake execution details for the expected answer.
      if (lastMessage || event.role !== 'assistant' || event.parentToolCallId !== null) continue
      const text = messageText(event)
      if (text) lastMessage = { text, at: entry.ts }
      continue
    }

    if (RESOLVED_TYPES.has(event.type)) {
      const resolved = event as Extract<SillageEvent, { requestId: string }>
      resolvedRequests.add(resolved.requestId)
      continue
    }

    const kind = PROMPT_KIND_BY_TYPE[event.type]
    if (!kind || pending) continue
    const requested = event as Extract<SillageEvent, { requestId: string }>
    if (resolvedRequests.has(requested.requestId)) continue
    pending = { kind, requestId: requested.requestId, requestedAt: entry.ts, event }
  }

  return { activity, lastMessage, pending }
}

/**
 * Task information available from its table row without reading the journal.
 *
 * `baseUrl` builds the interface link: agent-created tasks often reach humans,
 * and requiring them to reconstruct the URL is easily left undocumented.
 */
export function taskToSummaryDto(row: ConversationRow, baseUrl: string): TaskSummaryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    worktreeId: row.worktreeId,
    title: row.title,
    status: row.status,
    agent: row.agent,
    lastSeq: row.lastSeq,
    usage: {
      costUsd: row.costUsd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    },
    url: `${baseUrl}/p/${row.projectId}/c/${row.id}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Task state as seen by a machine caller.
 *
 * Reserved for individual task reads: folding reads the journal and counting
 * turns scans all of it, which a list cannot afford for every row.
 */
export function taskToDto(log: EventLog, row: ConversationRow, baseUrl: string): TaskDto {
  const { activity, lastMessage, pending } = digest(log, row.id)

  return {
    ...taskToSummaryDto(row, baseUrl),
    config: parseAgentConfig(row.config),
    turns: log.count(row.id, 'turn.completed'),
    activity: row.status === 'running' ? activity : null,
    lastMessage,
    pending,
  }
}
