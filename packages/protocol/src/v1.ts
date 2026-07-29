import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config.js'
import { conversationStatusSchema } from './api.js'
import { agentKindSchema, type AgentKind, type SillageEvent } from './events.js'

/**
 * L'API publique, celle que pilotent les clients machine.
 *
 * Elle parle tâche là où le reste de Sillage parle conversation : c'est le même objet,
 * dans la même table et le même journal, mais un appelant distant n'a pas à connaître
 * les DTO de l'interface, qui bougent au rythme des écrans. Cette traduction est le
 * prix d'un contrat stable.
 *
 * Attention au vocabulaire : `task.started` et `task.completed` existent déjà dans le
 * journal et y désignent un travail de fond du CLI, pas une tâche au sens de cette API.
 */

/** Ce qu'un appelant doit fournir : un prompt. Le reste se résout. */
export const createTaskBodySchema = z.object({
  prompt: z.string().min(1),
  /** Défaut : le CLI choisi à la création du jeton. */
  agent: agentKindSchema.optional(),
  /**
   * Surcharge partielle, en vocabulaire natif du CLI visé. Volontairement non unifiée :
   * `effort` chez Claude et `reasoningEffort` chez Codex ne recouvrent pas les mêmes
   * valeurs, et un champ commun mentirait. `GET /api/v1/agents` publie ce qui est accepté.
   *
   * Seuls les champs de `OVERRIDABLE_CONFIG_FIELDS` sont acceptés : les garde-fous ne
   * se règlent pas par requête.
   */
  config: z.record(z.string(), z.unknown()).optional(),
  worktreeId: z.string().nullable().default(null),
  title: z.string().max(200).optional(),
})

export const taskMessageBodySchema = z.object({
  prompt: z.string().min(1),
})

/**
 * Une inflexion n'existe que pendant un tour, et un appelant machine perd la course :
 * il lit `running`, envoie, et le tour s'est terminé entre-temps. `queue` bascule alors
 * en message ordinaire plutôt que de laisser tomber le texte.
 */
export const taskSteerBodySchema = z.object({
  prompt: z.string().min(1),
  onMissedTurn: z.enum(['queue', 'fail']).default('queue'),
})

export const taskListQuerySchema = z.object({
  status: conversationStatusSchema.optional(),
  projectId: z.string().optional(),
  /** Par défaut, seules les tâches lancées par le jeton appelant. */
  scope: z.enum(['token', 'user']).default('token'),
})

export const taskEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  /** Liste de types séparés par des virgules. Vide : tout sauf les deltas. */
  types: z.string().optional(),
})

/** Types trop bavards pour un client qui interroge : ils arrivent au token. */
export const V1_NOISY_EVENT_TYPES = [
  'message.delta',
  'thinking.delta',
  'tool.output_delta',
] as const

export interface TaskProjectDto {
  id: string
  name: string
  workspacePath: string
  /** Vrai si le workspace est un dépôt git, donc si un worktree est possible. */
  git: boolean
  worktrees: { id: string; name: string; branch: string }[]
  /** Ce qu'une tâche lancée sur ce projet utilisera si elle ne demande rien. */
  defaults: { agent: AgentKind; config: unknown }
}

/**
 * Ce qu'un CLI accepte en surcharge, pour qu'un appelant n'ait pas à deviner.
 *
 * `effortField` nomme le champ plutôt que de l'uniformiser : c'est `effort` chez Claude
 * et `reasoningEffort` chez Codex, avec des valeurs différentes. Décrire la clé native
 * renseigne sans inventer d'abstraction qui mentirait.
 */
export interface TaskAgentDto {
  agent: AgentKind
  label: string
  available: boolean
  effortField: string
  models: { value: string; displayName: string; isDefault: boolean; efforts: string[] }[]
}

/** L'appel d'outil en cours, quand l'agent travaille. */
export interface TaskActivityDto {
  toolCallId: string
  toolName: string
  startedAt: number
  /** Vrai quand l'appel vient d'un sous-agent et non du fil principal. */
  nested: boolean
}

export interface TaskPendingDto {
  kind: 'permission' | 'question' | 'plan' | 'elicitation'
  requestId: string
  requestedAt: number
  /** La demande telle qu'elle a été journalisée, pour n'avoir rien à retraduire. */
  event: SillageEvent
}

/**
 * Une tâche en liste, sans son état replié.
 *
 * Replier coûte une lecture du journal par tâche, et compter les tours un parcours
 * complet : acceptable pour une tâche qu'on consulte, ruineux pour cinquante qu'on
 * énumère. La liste dit donc ce que la table sait déjà, et `GET /tasks/:id` reste
 * l'endroit où l'on demande où en est une tâche précise.
 */
export interface TaskSummaryDto {
  id: string
  projectId: string
  worktreeId: string | null
  title: string
  status: z.infer<typeof conversationStatusSchema>
  agent: AgentKind
  lastSeq: number
  usage: { costUsd: number; inputTokens: number; outputTokens: number }
  url: string
  createdAt: number
  updatedAt: number
}

/**
 * L'état d'une tâche, déjà replié.
 *
 * Le journal brut ne répond pas à « où en est-elle » : il faut le replier, l'interface
 * a un fold entier pour ça, et un client qui lirait les événements verrait surtout
 * passer des deltas. Cette vue est ce qu'un appelant consulte en boucle ; `/events`
 * reste pour qui veut le détail.
 */
export interface TaskDto extends TaskSummaryDto {
  /** Configuration résolue : ce avec quoi la tâche tourne réellement. */
  config: unknown
  turns: number
  activity: TaskActivityDto | null
  lastMessage: { text: string; at: number } | null
  pending: TaskPendingDto | null
}

export interface TaskEventsPageDto {
  taskId: string
  events: { seq: number; ts: number; event: SillageEvent }[]
  /** Curseur à repasser en `after` au prochain appel. */
  nextAfter: number
  hasMore: boolean
}

/**
 * Nom du champ d'effort dans la configuration de chaque CLI.
 *
 * Table exhaustive plutôt que branchement : ajouter un CLI fait échouer la compilation
 * ici, ce qui vaut mieux que de publier une API qui tait un de ses réglages.
 */
export const EFFORT_FIELD: Record<AgentKind, string> = {
  claude: 'effort',
  codex: 'reasoningEffort',
}

/**
 * Ce qu'une requête a le droit de changer, par CLI.
 *
 * Liste blanche et non liste noire, parce que l'oubli doit pencher du côté sûr : un
 * champ ajouté demain à `AgentConfig` sera refusé tant qu'il n'est pas inscrit ici,
 * plutôt que surchargeable sans que personne ne l'ait décidé.
 *
 * Tout ce qui n'y figure pas relève des garde-fous (mode de permission, approbation,
 * bac à sable, répertoires supplémentaires, serveurs MCP) et se règle à la création
 * du jeton, dans l'interface. Sans cette barrière, un appelant demanderait
 * `permissionMode: bypassPermissions` ou `sandbox: danger-full-access` dans son corps
 * de requête, et le jeton ne vaudrait plus qu'un accès shell.
 */
export const OVERRIDABLE_CONFIG_FIELDS: Record<AgentKind, readonly string[]> = {
  claude: ['model', 'effort'],
  codex: ['model', 'reasoningEffort', 'collaborationMode'],
}

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>
export type TaskSteerBody = z.infer<typeof taskSteerBodySchema>

/**
 * Fond une surcharge dans une configuration résolue, puis valide l'ensemble.
 *
 * Les champs hors liste blanche sont rendus à l'appelant plutôt qu'ignorés en silence :
 * croire avoir désactivé un garde-fou serait pire que se l'entendre refuser.
 */
export function mergeAgentConfig(
  base: AgentConfig,
  override: Record<string, unknown> | undefined,
): { config: AgentConfig; rejected: string[] } {
  if (!override) return { config: agentConfigSchema.parse(base), rejected: [] }

  const allowed = OVERRIDABLE_CONFIG_FIELDS[base.agent]
  const rejected = Object.keys(override).filter((field) => !allowed.includes(field))
  if (rejected.length > 0) return { config: base, rejected }

  const merged: Record<string, unknown> = { ...base }
  for (const field of allowed) {
    if (field in override) merged[field] = override[field]
  }
  return { config: agentConfigSchema.parse(merged), rejected: [] }
}
