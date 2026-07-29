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
 * Événements qui décrivent le présent d'une conversation. Les deltas en sont exclus :
 * ils arrivent au token et ne disent rien de plus que l'appel d'outil qui les produit.
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
 * Combien d'entrées récentes suffisent à décrire le présent.
 *
 * Un tour ordinaire tient largement dedans. Au-delà, l'appel d'outil en cours et le
 * dernier message sont forcément plus récents que la borne, sauf fil resté ouvert
 * pendant des centaines d'outils sans jamais rien dire, cas où la vue rend `null`
 * plutôt qu'une valeur périmée.
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

/** Texte d'un message assistant, blocs de réflexion et d'outils retirés. */
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
 * Replie les dernières entrées du journal en un état lisible.
 *
 * La lecture se fait du plus récent au plus ancien, et s'arrête sur la première réponse
 * de chaque question : c'est ce qui rend la vue bornée, là où un fold complet paierait
 * tout l'historique à chaque consultation.
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
      // Un message de sous-agent n'est pas la parole de la conversation : le rendre
      // ferait passer un détail d'exécution pour la réponse attendue.
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
 * Ce qu'une tâche coûte gratuitement : sa ligne de table, sans toucher au journal.
 *
 * `baseUrl` sert à composer le lien vers l'interface : une tâche lancée par un agent
 * finit souvent devant un humain, et lui faire reconstruire l'URL est le genre de
 * détail qu'on oublie de documenter.
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
 * L'état d'une tâche tel qu'un appelant machine le consulte.
 *
 * Réservé à la consultation d'une tâche : le repliage lit le journal et le compte des
 * tours le parcourt entièrement, ce qu'une liste ne peut pas se permettre par ligne.
 */
export function taskToDto(log: EventLog, row: ConversationRow, baseUrl: string): TaskDto {
  const { activity, lastMessage, pending } = digest(log, row.id)

  return {
    ...taskToSummaryDto(row, baseUrl),
    config: parseAgentConfig(row.config),
    turns: log.count(row.id, 'turn.completed'),
    activity: row.status === 'running' ? activity : null,
    lastMessage,
    pending: row.status === 'awaiting_input' ? pending : null,
  }
}
