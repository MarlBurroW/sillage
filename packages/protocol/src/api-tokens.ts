import { z } from 'zod'
import { agentConfigSchema } from './agent-config.js'
import { agentKindSchema, type AgentKind } from './events.js'

/**
 * Jetons d'API : ce qu'un client machine présente en `Authorization: Bearer`.
 *
 * Un jeton n'ouvre que `/api/v1`, et le cookie de session n'ouvre que le reste. La
 * frontière est nette pour que les DTO de l'interface puissent bouger sans devenir un
 * contrat public, et pour qu'un jeton volé n'atteigne jamais l'administration des
 * comptes.
 */

/**
 * `tasks:autonomous` est la portée du mode sans garde-fou : elle seule autorise une
 * configuration où le CLI ne demande rien (`bypassPermissions`, ou `never` +
 * `danger-full-access` côté Codex). Portée dédiée et non simple option, pour qu'un
 * jeton capable d'exécution arbitraire se voie comme tel dans la liste, et se révoque
 * comme tel.
 */
export const apiScopeSchema = z.enum([
  'projects:read',
  'tasks:read',
  'tasks:write',
  'tasks:autonomous',
])
export type ApiScope = z.infer<typeof apiScopeSchema>

/** Préfixe en clair, pour qu'un jeton trouvé dans un fichier de configuration se reconnaisse. */
export const API_TOKEN_PREFIX = 'sillage_pat_'

export interface ApiTokenDto {
  id: string
  label: string
  /** Premiers caractères du secret, seule partie réaffichable après la création. */
  hint: string
  scopes: ApiScope[]
  /** Projets autorisés ; vide signifie « tous ceux que son utilisateur voit ». */
  projectIds: string[]
  agent: AgentKind
  config: unknown
  /** URL appelée sur les événements de tâche ; null quand le jeton n'en veut pas. */
  webhookUrl: string | null
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

/**
 * Le secret d'authentification n'est rendu qu'une fois, à la création : seule son
 * empreinte est stockée. Le secret de webhook, lui, sert à signer côté serveur, donc
 * il reste lisible en base ; il n'est montré qu'ici parce qu'après, l'écran n'a plus
 * de raison de l'exposer.
 */
export interface CreatedApiTokenDto {
  token: ApiTokenDto
  secret: string
  webhookSecret: string
}

/**
 * Le CLI et sa configuration sont obligatoires : c'est ici que se décide avec quoi les
 * agents travailleront, une fois, par quelqu'un qui sait ce qu'il fait. Les tâches se
 * lancent ensuite avec un simple prompt.
 */
export const createApiTokenBodySchema = z.object({
  label: z.string().min(1).max(120),
  scopes: z.array(apiScopeSchema).min(1),
  projectIds: z.array(z.string()).default([]),
  agent: agentKindSchema,
  config: agentConfigSchema,
  expiresAt: z.number().int().positive().nullable().default(null),
  /** Où livrer les webhooks de tâches. Facultative : le polling reste complet sans. */
  webhookUrl: z.string().url().nullable().default(null),
})

/**
 * Un jeton ne se modifie pas, il se révoque.
 *
 * Élargir des portées ou changer de CLI sans changer le secret laisserait un accès déjà
 * distribué gagner des droits qu'il n'avait pas quand on l'a confié. Recréer coûte un
 * échange de secret, ce qui est précisément le geste attendu.
 */
export const updateApiTokenBodySchema = z.object({
  revoked: z.literal(true),
})
