import type { AgentKind, JournalEntry, SillageEvent } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'

/** Conversation handoff to another CLI. A budgeted history selection inspired by T3 Code's portable handoffs rather than an agent-written summary: retained messages keep their full text, order and roles; omitted content is referenced for rereading with Sillage MCP's `read_conversation`. Selection uses the normalized journal without knowing the source CLI. Inject text into each CLI's instruction channel (Claude system prompt, Codex `developerInstructions`, opencode `system`) for the conversation lifetime, like ordinary history. The user's new request is the first message and is never shortened. */

/** Default budget and limits in tokens, matching T3 Code. */
export const DEFAULT_HANDOFF_TOKENS = 16_000
export const MIN_HANDOFF_TOKENS = 1_000
export const MAX_HANDOFF_TOKENS = 64_000

/** One byte per token conservatively overestimates ordinary text by three to four times. Exact counts require the target model tokenizer, but transfers must fit any target. */
const BYTES_PER_TOKEN = 1

/** Tool-call share: truncated input and output. Command results provide context, but 20 KB of output adds little beyond its opening lines while displacing entire messages. */
const TOOL_INPUT_MAX = 400
const TOOL_OUTPUT_MAX = 1_200

/** Journal pages read for selection, matching conversation replay pages. */
const PAGE_ROWS = 5000
const PAGE_BYTES = 16_000_000

export class HandoffError extends Error {
  constructor(
    readonly code: 'handoff_empty' | 'handoff_too_large',
    message: string,
  ) {
    super(message)
    this.name = 'HandoffError'
  }
}

/** Conversation element as measured by selection. */
export type HandoffItem =
  | { kind: 'user' | 'assistant'; seq: number; text: string }
  | {
      kind: 'tool'
      seq: number
      name: string
      input: string
      output: string
      isError: boolean
    }
  /** Turn ending without a response: preceding work is partial. */
  | { kind: 'interrupted'; seq: number; reason: string }

export interface HandoffSelection {
  /** Original request, the first user message. */
  head: HandoffItem | null
  /** Latest exchanges in order, with no gaps except tool calls. */
  tail: HandoffItem[]
  /** Messages between the original request and retained ending, available by reference. */
  omitted: { messages: number; fromSeq: number; toSeq: number } | null
  /** Tool calls omitted within the retained window because of the budget. */
  omittedTools: number
}

export interface HandoffSource {
  id: string
  title: string
  agent: AgentKind
}

export interface HandoffResult {
  text: string
  bytes: number
  budgetTokens: number
  selected: number
  omitted: number
}

/** Clamps requested budgets to limits and uses the default when absent. */
export function clampHandoffTokens(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_HANDOFF_TOKENS
  return Math.min(MAX_HANDOFF_TOKENS, Math.max(MIN_HANDOFF_TOKENS, Math.floor(requested)))
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[... truncated, ${text.length - max} more characters]` : text
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Tool output as the agent saw it: block text or JSON. */
function toolOutputText(output: unknown): string {
  if (Array.isArray(output)) {
    const texts = output
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : null))
      .filter((text): text is string => text !== null)
    if (texts.length > 0) return texts.join('\n')
  }
  if (output && typeof output === 'object' && 'text' in output && typeof (output as { text: unknown }).text === 'string') {
    return (output as { text: string }).text
  }
  return stringify(output)
}

/** Folds the journal into main-conversation elements. Assistant responses span several `message.completed` entries (reasoning then tools); combine text under the first `seq`. Ignore subagents because their work returns through launching tool results. Place tool calls at `tool.completed`, the only event carrying output; unfinished calls from interrupted turns remain without output. */
export function collectHandoffItems(entries: Iterable<JournalEntry>): HandoffItem[] {
  const items: HandoffItem[] = []
  const messages = new Map<string, Extract<HandoffItem, { kind: 'user' | 'assistant' }>>()
  const tools = new Map<string, Extract<HandoffItem, { kind: 'tool' }>>()

  for (const entry of entries) {
    const event: SillageEvent = entry.event
    switch (event.type) {
      case 'message.completed': {
        if (event.parentToolCallId) break
        const text = event.blocks
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
        if (!text) break
        const known = messages.get(event.messageId)
        if (known) {
          known.text = `${known.text}\n\n${text}`
          break
        }
        const item = { kind: event.role, seq: entry.seq, text } as const
        const mutable: Extract<HandoffItem, { kind: 'user' | 'assistant' }> = { ...item }
        messages.set(event.messageId, mutable)
        items.push(mutable)
        break
      }
      case 'tool.started': {
        if (event.parentToolCallId) break
        const item: Extract<HandoffItem, { kind: 'tool' }> = {
          kind: 'tool',
          seq: entry.seq,
          name: event.name,
          input: clip(stringify(event.input), TOOL_INPUT_MAX),
          output: '',
          isError: false,
        }
        tools.set(event.toolCallId, item)
        items.push(item)
        break
      }
      case 'tool.completed': {
        const item = tools.get(event.toolCallId)
        if (!item) break
        item.isError = event.isError
        item.output =
          event.output === null && event.outputBytes !== undefined
            ? `[output of ${event.outputBytes} bytes, not transferred]`
            : clip(toolOutputText(event.output), TOOL_OUTPUT_MAX)
        break
      }
      case 'turn.completed': {
        if (event.stopReason === 'interrupted' || event.stopReason === 'failed') {
          items.push({ kind: 'interrupted', seq: entry.seq, reason: event.stopReason })
        }
        break
      }
      default:
        break
    }
  }
  return items
}

/** Bytes an element occupies when rendered. */
export function itemBytes(item: HandoffItem): number {
  return Buffer.byteLength(renderItem(item)) + 2
}

/** Selects content fitting the budget. Priorities: original request, since conclusions without context mislead; latest messages backward without skipping, preserving a readable conversation; then newest tool calls within that window using remaining space. Interrupted turns count as messages because a few bytes alter interpretation of preceding work. `budgetBytes` excludes header and reference costs already deducted by the caller. */
export function selectHandoff(items: HandoffItem[], budgetBytes: number): HandoffSelection {
  const headIndex = items.findIndex((item) => item.kind === 'user')
  const head = headIndex >= 0 ? items[headIndex]! : null
  let remaining = budgetBytes - (head ? itemBytes(head) : 0)
  if (remaining < 0) throw new HandoffError('handoff_too_large', 'The original request alone exceeds the handoff budget.')

  // Messages and interruptions after the request, newest first.
  const rest = items.slice(headIndex + 1)
  let windowStart = rest.length
  for (let i = rest.length - 1; i >= 0; i--) {
    const item = rest[i]!
    if (item.kind === 'tool') continue
    const size = itemBytes(item)
    if (size > remaining) break
    remaining -= size
    windowStart = i
  }

  // Tools between the last omitted message and the window belong to the turn that
  // opens that window. Without omitted messages, include the entire thread.
  while (windowStart > 0 && rest[windowStart - 1]!.kind === 'tool') windowStart--

  // Tools within the window, newest first.
  const keptTools = new Set<number>()
  let omittedTools = 0
  for (let i = rest.length - 1; i >= windowStart; i--) {
    const item = rest[i]!
    if (item.kind !== 'tool') continue
    const size = itemBytes(item)
    if (size <= remaining) {
      remaining -= size
      keptTools.add(i)
    } else {
      omittedTools++
    }
  }

  const tail = rest.filter((item, i) => i >= windowStart && (item.kind !== 'tool' || keptTools.has(i)))
  const skipped = rest.slice(0, windowStart).filter((item) => item.kind !== 'tool')
  const omitted =
    skipped.length > 0
      ? { messages: skipped.length, fromSeq: skipped[0]!.seq, toSeq: skipped[skipped.length - 1]!.seq }
      : null

  return { head, tail, omitted, omittedTools }
}

const AGENT_NAMES: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'opencode',
  grok: 'Grok Build',
}

function renderItem(item: HandoffItem): string {
  switch (item.kind) {
    case 'user':
      return `## User (message ${item.seq})\n${item.text}`
    case 'assistant':
      return `## Agent (message ${item.seq})\n${item.text}`
    case 'tool': {
      const lines = [`### Tool ${item.name}${item.isError ? ' (failed)' : ''}`]
      if (item.input) lines.push(`Input: ${item.input}`)
      lines.push(item.output ? `Output: ${item.output}` : 'Output: none; the turn was interrupted beforehand.')
      return lines.join('\n')
    }
    case 'interrupted':
      return item.reason === 'interrupted'
        ? '[Turn interrupted by the user: the work above is partial.]'
        : '[Turn ended in error: the work above is partial.]'
  }
}

/** Header identifying the source conversation and how to reread omissions. */
export function renderHandoffHeader(source: HandoffSource, target: AgentKind): string {
  return [
    `# Continuing a conversation with ${AGENT_NAMES[source.agent]}`,
    '',
    `This conversation continues “${source.title}” (id ${source.id}), previously handled by ${AGENT_NAMES[source.agent]} in Sillage and now by ${AGENT_NAMES[target]}. Below are original messages, in full and in order, with tool calls that fit; this is not a summary. Reasoning, tool state and attachments are not transferred. Omitted sections include references: read them using the \`sillage\` MCP server's \`read_conversation\` tool (\`id\` and \`before\` parameters) whenever details are missing, rather than guessing.`,
    '',
    "The request to handle is the first message in this conversation after this block: it takes precedence, and the thread below is context only. If project memory or another session contradicts this thread, you are continuing this thread: report the contradiction rather than silently choosing a side.",
  ].join('\n')
}

function renderOmitted(source: HandoffSource, omitted: NonNullable<HandoffSelection['omitted']>, before: number): string {
  return `[${omitted.messages} message(s) omitted here, from message ${omitted.fromSeq} to ${omitted.toSeq}. To read them: read_conversation with id="${source.id}" and before=${before}, then continue backward using the \`before\` value reported by the tool.]`
}

/** Complete text ready for injection. */
export function renderHandoff(source: HandoffSource, target: AgentKind, selection: HandoffSelection): string {
  const parts = [renderHandoffHeader(source, target), '## Original thread']
  if (selection.head) parts.push(renderItem(selection.head))
  if (selection.omitted) {
    const before = selection.tail[0]?.seq ?? selection.omitted.toSeq + 1
    parts.push(renderOmitted(source, selection.omitted, before))
  }
  for (const item of selection.tail) parts.push(renderItem(item))
  if (selection.omittedTools > 0) {
    parts.push(`[${selection.omittedTools} tool call(s) from this period omitted for space.]`)
  }
  return parts.join('\n\n')
}

/** Builds a conversation handoff. The transferred history budget counts the reference before messages: it survives when nothing else fits, and transfers unable even to reference omitted history fail instead of going silent. Headers have fixed overhead outside the budget, like instructions; counting them would empty the minimum budget. */
export function buildHandoff(
  items: HandoffItem[],
  source: HandoffSource,
  target: AgentKind,
  budgetTokens: number,
): HandoffResult {
  if (items.length === 0) throw new HandoffError('handoff_empty', 'This conversation has no message to carry over.')

  const budgetBytes = budgetTokens * BYTES_PER_TOKEN
  // Worst-case reference: all messages omitted, six-digit numbers.
  const reference = renderOmitted(source, { messages: items.length, fromSeq: 999_999, toSeq: 999_999 }, 999_999)
  const fixed = Buffer.byteLength(reference) + 64
  if (fixed > budgetBytes) {
    throw new HandoffError('handoff_too_large', 'The handoff budget cannot even hold the references to the thread.')
  }

  const selection = selectHandoff(items, budgetBytes - fixed)
  const text = renderHandoff(source, target, selection)
  return {
    text,
    bytes: Buffer.byteLength(text) - Buffer.byteLength(renderHandoffHeader(source, target)),
    budgetTokens,
    selected: selection.tail.length + (selection.head ? 1 : 0),
    omitted: selection.omitted?.messages ?? 0,
  }
}

/** Conversation elements read in pages like conversation replay. */
export function readHandoffItems(log: EventLog, conversationId: string): HandoffItem[] {
  const entries: JournalEntry[] = []
  let after = 0
  for (;;) {
    const page = log.readForReplay(conversationId, after, { rows: PAGE_ROWS, bytes: PAGE_BYTES })
    entries.push(...page.entries)
    if (page.nextAfter === after) break
    after = page.nextAfter
  }
  return collectHandoffItems(entries)
}
