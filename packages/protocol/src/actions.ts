import { z } from 'zod'
import type { TerminalDto } from './terminal.js'

/**
 * Actions de projet : des boutons qui lancent une commande dans le dossier du projet.
 *
 * Tenues par Sillage, jamais écrites dans le dépôt : chacun a son propre outillage, et
 * un `.sillage/` versionné imposerait le sien à tous ceux qui clonent.
 *
 * Deux natures, parce qu'elles ne vivent pas pareil :
 * - `task` : une commande ponctuelle (tests, seed, build), jouée dans un terminal du
 *   panneau, qui se termine et laisse son écran et son code de sortie ;
 * - `service` : une commande qui tourne (serveur de dev, worker), portée par une unité
 *   systemd `sillage-app-*` pour survivre au daemon et apparaître dans Services. Sans
 *   systemd utilisateur (macOS, conteneur), elle retombe dans un terminal.
 *
 * Les bornes sont ici parce que le formulaire les affiche et que l'outil MCP
 * `register_action` doit refuser la même chose que la route.
 */

export const MAX_ACTION_LABEL_CHARS = 60
export const MAX_ACTION_DESCRIPTION_CHARS = 300
export const MAX_ACTION_COMMAND_CHARS = 4000
export const MAX_ACTION_SUBDIR_CHARS = 300
export const MAX_ACTION_URL_CHARS = 500
/** Au-delà, ce n'est plus une barre de boutons mais un Makefile. */
export const MAX_ACTIONS_PER_PROJECT = 30

export const projectActionKindSchema = z.enum(['task', 'service'])
export type ProjectActionKind = z.infer<typeof projectActionKindSchema>

/**
 * Sous-dossier relatif au worktree où la commande s'exécute. Relatif et sans `..` :
 * une action suit le worktree de la conversation, un chemin absolu la ferait toujours
 * tourner au même endroit.
 */
export const actionSubdirSchema = z
  .string()
  .trim()
  .max(MAX_ACTION_SUBDIR_CHARS)
  .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), {
    message: 'Relative path inside the project, without "..".',
  })

/**
 * Adresse où ouvrir un service, pour un lien dans l'interface. `{port}` y est remplacé
 * par le premier port sur lequel le service écoute : l'agent n'a pas à deviner celui
 * qu'un serveur de dev aura pris. Elle doit être joignable depuis le navigateur de
 * l'utilisateur, ce qui exclut souvent `localhost` quand Sillage tourne ailleurs.
 */
export const actionUrlSchema = z
  .string()
  .trim()
  .max(MAX_ACTION_URL_CHARS)
  .refine((value) => value === '' || isHttpUrl(value.replaceAll('{port}', '1')), {
    message: 'An http(s) URL, optionally with {port}.',
  })

/** Sans `URL`, absent des types de ce paquet partagé entre navigateur et serveur. */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(value)
}

/**
 * L'URL à ouvrir, ou null : sans gabarit, ou avec `{port}` alors que le service
 * n'écoute encore sur rien.
 */
export function resolveActionUrl(template: string | null, ports: readonly number[]): string | null {
  if (!template) return null
  if (!template.includes('{port}')) return template
  const port = ports[0]
  return port === undefined ? null : template.replaceAll('{port}', String(port))
}

export const createProjectActionBodySchema = z.object({
  label: z.string().trim().min(1).max(MAX_ACTION_LABEL_CHARS),
  description: z.string().trim().max(MAX_ACTION_DESCRIPTION_CHARS).optional(),
  kind: projectActionKindSchema,
  command: z.string().trim().min(1).max(MAX_ACTION_COMMAND_CHARS),
  subdir: actionSubdirSchema.optional(),
  url: actionUrlSchema.optional(),
})
export type CreateProjectActionBody = z.infer<typeof createProjectActionBodySchema>

export const updateProjectActionBodySchema = createProjectActionBodySchema.partial()
export type UpdateProjectActionBody = z.infer<typeof updateProjectActionBodySchema>

/** Depuis une conversation, l'action tourne dans son worktree ; sinon à la racine du projet. */
export const runProjectActionBodySchema = z.object({
  conversationId: z.string().min(1).optional(),
})

export const serviceActionControlSchema = z.enum(['stop', 'restart'])
export type ServiceActionControl = z.infer<typeof serviceActionControlSchema>

/** État d'une action `service` portée par systemd. */
export interface ProjectActionServiceState {
  unit: string
  /** `ActiveState` de systemd ; `inactive` quand l'unité n'existe pas. */
  state: string
  cwd: string | null
  ports: number[]
  startedAt: number | null
}

export interface ProjectActionDto {
  id: string
  projectId: string
  label: string
  description: string | null
  kind: ProjectActionKind
  command: string
  subdir: string | null
  /** Gabarit d'URL d'un service, `{port}` compris ; null sans lien. */
  url: string | null
  /**
   * `proposed` : écrite ou modifiée par un agent et pas encore relue. Un clic lance la
   * commande hors de toute session : on la montre avant la première exécution, pour
   * qu'une injection de prompt ne puisse pas y glisser ce qu'on lancerait sans voir.
   */
  status: 'approved' | 'proposed'
  /** Conversation qui l'a créée ou modifiée en dernier ; null depuis l'interface. */
  agentConversationId: string | null
  /** Son titre, pour dire d'où vient une action à relire ; null si elle n'existe plus. */
  agentConversationTitle: string | null
  createdAt: number
  updatedAt: number
  /** Null pour une `task`, ou quand systemd n'est pas disponible. */
  service: ProjectActionServiceState | null
  /** Dernière exécution dans un terminal, tant que son onglet est ouvert. */
  lastRun: ProjectActionLastRun | null
}

export interface ProjectActionLastRun {
  terminalId: string
  alive: boolean
  /** Null tant qu'elle tourne, ou si un redémarrage du daemon l'a interrompue. */
  exitCode: number | null
  startedAt: number
}

/** Ce que rend une exécution : le terminal ouvert, ou l'unité démarrée. */
export interface ProjectActionRunResult {
  terminal: TerminalDto | null
  service: ProjectActionServiceState | null
  /** Une exécution précédente tourne encore : on la rend au lieu d'en lancer une seconde. */
  alreadyRunning: boolean
}
