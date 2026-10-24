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

/** Context inherited before this journal began, including the original cut point. */
export interface InheritedHandoff {
  text: string
  fromConversationId: string
  throughSeq: number
}

/** Clamps requested budgets to limits and uses the default when absent. */
export function clampHandoffTokens(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_HANDOFF_TOKENS
  return Math.min(MAX_HANDOFF_TOKENS, Math.max(MIN_HANDOFF_TOKENS, Math.floor(requested)))
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[... tronqué, ${text.length - max} caractères de plus]` : text
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
            ? `[sortie de ${event.outputBytes} octets, non transférée]`
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
  antigravity: 'Google Antigravity',
}

function renderItem(item: HandoffItem): string {
  switch (item.kind) {
    case 'user':
      return `## Utilisateur (message ${item.seq})\n${item.text}`
    case 'assistant':
      return `## Agent (message ${item.seq})\n${item.text}`
    case 'tool': {
      const lines = [`### Outil ${item.name}${item.isError ? ' (en erreur)' : ''}`]
      if (item.input) lines.push(`Entrée : ${item.input}`)
      lines.push(item.output ? `Sortie : ${item.output}` : 'Sortie : aucune, le tour a été interrompu avant.')
      return lines.join('\n')
    }
    case 'interrupted':
      return item.reason === 'interrupted'
        ? "[Tour interrompu par l'utilisateur : ce qui précède est un travail partiel.]"
        : '[Tour terminé en erreur : ce qui précède est un travail partiel.]'
  }
}

/** Header identifying the source conversation and how to reread omissions. */
export function renderHandoffHeader(source: HandoffSource, target: AgentKind): string {
  return [
    `# Suite d'une conversation menée avec ${AGENT_NAMES[source.agent]}`,
    '',
    `Cette conversation continue « ${source.title} » (id ${source.id}), menée avec ${AGENT_NAMES[source.agent]} dans Sillage, et poursuivie maintenant avec ${AGENT_NAMES[target]}. Ce qui suit n'est pas un résumé : ce sont des messages du fil d'origine, en entier et dans l'ordre, avec les appels d'outils qui tenaient. Le raisonnement, l'état des outils et les pièces jointes ne sont pas transférés. Les parties omises sont signalées par une référence : relis-les avec l'outil \`read_conversation\` du serveur MCP \`sillage\` (paramètres \`id\` et \`before\`) dès qu'un détail te manque, plutôt que de le deviner.`,
    '',
    "La demande à traiter est le premier message de cette conversation, après ce bloc : c'est elle qui fait foi, le fil ci-dessous n'est que son contexte. Si ta mémoire de projet ou une autre session dit autre chose que ce fil, c'est ce fil que tu continues : signale la contradiction plutôt que de trancher en silence.",
  ].join('\n')
}

function renderOmitted(source: HandoffSource, omitted: NonNullable<HandoffSelection['omitted']>, before: number): string {
  return `[${omitted.messages} message(s) omis ici, du message ${omitted.fromSeq} au message ${omitted.toSeq}. Pour les relire : read_conversation avec id="${source.id}" et before=${before}, puis remonter avec la valeur de \`before\` que l'outil annonce.]`
}

/** Complete text ready for injection. */
export function renderHandoff(source: HandoffSource, target: AgentKind, selection: HandoffSelection): string {
  const parts = [renderHandoffHeader(source, target), '## Fil d\'origine']
  if (selection.head) parts.push(renderItem(selection.head))
  if (selection.omitted) {
    const before = selection.tail[0]?.seq ?? selection.omitted.toSeq + 1
    parts.push(renderOmitted(source, selection.omitted, before))
  }
  for (const item of selection.tail) parts.push(renderItem(item))
  if (selection.omittedTools > 0) {
    parts.push(`[${selection.omittedTools} appel(s) d'outil de cette période omis, faute de place.]`)
  }
  return parts.join('\n\n')
}

/** Builds a conversation handoff. The transferred history budget counts the reference before messages: it survives when nothing else fits, and transfers unable even to reference omitted history fail instead of going silent. Headers have fixed overhead outside the budget, like instructions; counting them would empty the minimum budget. */
export function buildHandoff(
  items: HandoffItem[],
  source: HandoffSource,
  target: AgentKind,
  budgetTokens: number,
  inherited?: InheritedHandoff | null,
): HandoffResult {
  if (items.length === 0) throw new HandoffError('handoff_empty', 'This conversation has no message to carry over.')

  const budgetBytes = budgetTokens * BYTES_PER_TOKEN
  // Worst-case reference: all messages omitted, six-digit numbers.
  const reference = renderOmitted(source, { messages: items.length, fromSeq: 999_999, toSeq: 999_999 }, 999_999)
  const fixed = Buffer.byteLength(reference) + 64
  if (fixed > budgetBytes) {
    throw new HandoffError('handoff_too_large', 'The handoff budget cannot even hold the references to the thread.')
  }

  let prefix = ''
  if (inherited) {
    const reference = `## Contexte hérité avant ce fil\nRelire avec read_conversation, id="${inherited.fromConversationId}" et before=${inherited.throughSeq + 1}. Ne pas inclure les échanges postérieurs à ce point.`
    const full = reference + '\n\n' + inherited.text
    const original = items.find((item) => item.kind === 'user')
    // Reserve the latest thread's original request and at least half the budget
    // for its exchanges; repeated forks must not grow instructions indefinitely.
    const room = Math.min((budgetBytes - fixed) / 2, budgetBytes - fixed - (original ? itemBytes(original) : 0))
    prefix = (Buffer.byteLength(full) + 2 <= room ? full : reference) + '\n\n'
  }
  const selection = selectHandoff(items, budgetBytes - fixed - Buffer.byteLength(prefix))
  const text = prefix + renderHandoff(source, target, selection)
  return {
    text,
    bytes: Buffer.byteLength(text) - Buffer.byteLength(renderHandoffHeader(source, target)),
    budgetTokens,
    selected: selection.tail.length + (selection.head ? 1 : 0),
    omitted: selection.omitted?.messages ?? 0,
  }
}

/** Conversation elements read in pages like conversation replay. */
export function readHandoffItems(log: EventLog, conversationId: string, throughSeq = Infinity): HandoffItem[] {
  const entries: JournalEntry[] = []
  let after = 0
  for (;;) {
    const page = log.readForReplay(conversationId, after, { rows: PAGE_ROWS, bytes: PAGE_BYTES })
    entries.push(...page.entries.filter((entry) => entry.seq <= throughSeq))
    if (page.nextAfter === after || page.nextAfter >= throughSeq) break
    after = page.nextAfter
  }
  return collectHandoffItems(entries)
}
