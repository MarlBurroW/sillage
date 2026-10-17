import type { AgentKind, JournalEntry, SillageEvent } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'

/**
 * Transfert d'une conversation vers un autre CLI.
 *
 * Pas un résumé écrit par un agent, mais une sélection budgétée du fil, sur le modèle
 * des « portable handoffs » de T3 Code : les messages retenus gardent leur texte entier,
 * leur ordre et leur rôle, et ce qui ne tient pas est remplacé par une référence que le
 * nouvel agent relit avec `read_conversation` du serveur MCP de Sillage. La sélection
 * se fait sur le journal normalisé, donc elle ne sait pas quel CLI a produit le fil.
 *
 * Le texte rendu part dans le canal de consignes de chaque CLI (prompt système chez
 * Claude, `developerInstructions` chez Codex, `system` chez opencode) et y reste pour
 * toute la vie de la conversation, comme l'historique d'un fil ordinaire. La nouvelle
 * demande de l'utilisateur, elle, est son premier message, jamais raccourci.
 */

/** Budget par défaut et bornes, en jetons, comme T3 Code. */
export const DEFAULT_HANDOFF_TOKENS = 16_000
export const MIN_HANDOFF_TOKENS = 1_000
export const MAX_HANDOFF_TOKENS = 64_000

/**
 * Un octet par jeton : un compte prudent, qui surestime d'un facteur trois à quatre sur
 * du texte courant. Compter juste demanderait le tokenizer du modèle cible, et le
 * transfert doit tenir quel que soit celui-ci.
 */
const BYTES_PER_TOKEN = 1

/**
 * Part d'un appel d'outil : son entrée et sa sortie, coupées. Les résultats de
 * commandes situent le travail, mais une sortie de 20 ko n'oriente pas mieux que ses
 * premières lignes, et prendrait la place d'un message entier.
 */
const TOOL_INPUT_MAX = 400
const TOOL_OUTPUT_MAX = 1_200

/** Pages du journal relues pour bâtir la sélection : celles de la relecture du fil. */
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

/** Un élément du fil, tel que la sélection le pèse. */
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
  /** Fin de tour sans réponse : le travail qui précède est partiel. */
  | { kind: 'interrupted'; seq: number; reason: string }

export interface HandoffSelection {
  /** La demande d'origine, premier message de l'utilisateur. */
  head: HandoffItem | null
  /** Les derniers échanges, dans l'ordre, sans trou autre que des appels d'outils. */
  tail: HandoffItem[]
  /** Messages entre la demande et la fin retenue, à relire par référence. */
  omitted: { messages: number; fromSeq: number; toSeq: number } | null
  /** Appels d'outils écartés à l'intérieur de la fenêtre retenue, faute de place. */
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

/** Ramène le budget demandé dans les bornes, et l'absence au défaut. */
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

/** La sortie d'un outil telle que l'agent l'a vue : le texte des blocs, ou le JSON. */
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

/**
 * Replie le journal en éléments du fil principal.
 *
 * Un message assistant arrive en plusieurs `message.completed` (réflexion, puis appels
 * d'outils) : ses textes sont réunis sous le premier `seq`. Les sous-agents sont
 * ignorés, leur travail revenant par le résultat de l'appel qui les a lancés. Un appel
 * d'outil se pose à la place de son `tool.completed`, qui seul porte la sortie ; un
 * appel sans fin (tour interrompu) reste, sans sortie.
 */
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

/** Octets qu'un élément pèsera une fois rendu. */
export function itemBytes(item: HandoffItem): number {
  return Buffer.byteLength(renderItem(item)) + 2
}

/**
 * Choisit ce qui tient dans le budget.
 *
 * Trois priorités, dans l'ordre : la demande d'origine, parce que des conclusions sans
 * énoncé se lisent de travers ; les derniers messages, en remontant depuis la fin sans
 * sauter de message, pour que la fenêtre reste un fil lisible ; puis les appels
 * d'outils de cette fenêtre, les plus récents d'abord, avec ce qu'il reste. Les tours
 * interrompus comptent comme des messages : quelques octets qui changent la lecture de
 * ce qui précède.
 *
 * `budgetBytes` est ce qui reste après l'en-tête et la référence : l'appelant les a
 * déjà déduits.
 */
export function selectHandoff(items: HandoffItem[], budgetBytes: number): HandoffSelection {
  const headIndex = items.findIndex((item) => item.kind === 'user')
  const head = headIndex >= 0 ? items[headIndex]! : null
  let remaining = budgetBytes - (head ? itemBytes(head) : 0)
  if (remaining < 0) throw new HandoffError('handoff_too_large', 'The original request alone exceeds the handoff budget.')

  // Les messages (et interruptions) après la demande, du plus récent au plus ancien.
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

  // Les outils entre le dernier message omis et la fenêtre appartiennent au tour qui
  // ouvre celle-ci : ils en font partie. Sans message omis, c'est tout le fil.
  while (windowStart > 0 && rest[windowStart - 1]!.kind === 'tool') windowStart--

  // Les outils de la fenêtre, les plus récents d'abord.
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

/** L'en-tête, qui dit d'où vient ce fil et comment relire ce qui manque. */
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

/** Le texte entier, prêt à injecter. */
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

/**
 * Bâtit le transfert d'une conversation.
 *
 * Le budget porte sur le fil transmis : la référence y est comptée avant les messages,
 * parce qu'elle est ce qui reste quand rien d'autre ne tient, et un transfert qui ne
 * pourrait même pas dire où relire échoue plutôt que de partir muet. L'en-tête, lui,
 * est un coût fixe hors budget, comme les consignes : le compter ferait du budget
 * minimal un budget vide.
 */
export function buildHandoff(
  items: HandoffItem[],
  source: HandoffSource,
  target: AgentKind,
  budgetTokens: number,
): HandoffResult {
  if (items.length === 0) throw new HandoffError('handoff_empty', 'This conversation has no message to carry over.')

  const budgetBytes = budgetTokens * BYTES_PER_TOKEN
  // La référence au pire : tous les messages omis, numéros à six chiffres.
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

/** Les éléments d'une conversation, lus par pages comme la relecture du fil. */
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
