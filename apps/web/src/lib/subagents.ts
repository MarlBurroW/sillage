import { activityOf, type ChatItem, type ToolItem } from './chat-fold'

/**
 * Les sous-agents d'une conversation, dérivés du seul journal (invariant I2).
 *
 * Un sous-agent n'a pas d'existence propre côté serveur : c'est un appel d'outil,
 * et tout ce qu'il produit porte l'identifiant de cet appel. Cet identifiant lui
 * sert donc d'identité ici, sans état parallèle à tenir ni requête à faire.
 */

/** Outils qui lancent un sous-agent, selon les CLI. */
const SPAWN_TOOLS = new Set(['Task', 'Agent'])

export function isSpawnTool(name: string): boolean {
  return SPAWN_TOOLS.has(name)
}

export interface SubAgent {
  /** L'appel qui l'a lancé. Sert d'identité et de clé de rattachement. */
  id: string
  /** Type déclaré à l'appel (`Explore`, `general-purpose`...), ou l'outil à défaut. */
  type: string
  /** Ce que l'appel dit chercher. Vide si le CLI n'en donne pas. */
  description: string
  status: ToolItem['status']
  startedAt: number
  /** Connue seulement une fois l'appel terminé : le CLI ne la donne pas avant. */
  durationMs: number | null
  /** Ce qu'il fait en ce moment, ou null s'il ne tourne plus. */
  activity: string | null
  /** Le fil du sous-agent, dans l'ordre du journal. */
  items: ChatItem[]
  /** Nombre d'appels d'outils qu'il a passés, sous-agents imbriqués compris. */
  toolCount: number
  /** L'appel de spawn du sous-agent parent, pour les imbrications. */
  parentId: string | null
}

function field(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return ''
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Un sous-agent par appel de spawn, dans l'ordre où ils ont été lancés.
 *
 * Un appel dont le journal ne porte encore aucune retombée reste dans la liste : entre
 * le lancement et le premier événement du sous-agent, il s'écoule plusieurs secondes,
 * et l'omettre ferait apparaître puis clignoter le bandeau.
 */
export function buildSubAgents(items: ChatItem[]): SubAgent[] {
  const byId = new Map<string, SubAgent>()

  for (const item of items) {
    if (item.kind !== 'tool' || !isSpawnTool(item.name)) continue
    byId.set(item.id, {
      id: item.id,
      type: field(item.input, 'subagent_type') || item.name,
      description: field(item.input, 'description'),
      status: item.status,
      startedAt: item.ts,
      durationMs: item.durationMs,
      activity: null,
      items: [],
      toolCount: 0,
      parentId: item.parentToolCallId,
    })
  }

  if (byId.size === 0) return []

  for (const item of items) {
    if (item.kind !== 'message' && item.kind !== 'tool') continue
    const parent = item.parentToolCallId ? byId.get(item.parentToolCallId) : undefined
    if (!parent) continue

    parent.items.push(item)
    if (item.kind === 'tool') parent.toolCount += 1
  }

  const agents = [...byId.values()]
  for (const agent of agents) {
    agent.activity = agent.status === 'running' ? activityOf(agent.items, agent.id) : null
  }
  return agents
}

/** Comment nommer un sous-agent dans une liste, au plus court qui reste parlant. */
export function subAgentLabel(agent: SubAgent): string {
  return agent.description || agent.type
}
