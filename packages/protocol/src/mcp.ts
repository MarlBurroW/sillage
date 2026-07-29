import { z } from 'zod'

/**
 * Serveurs MCP déclarés dans Sillage.
 *
 * Un seul modèle pour les deux CLI, parce que la déclaration est la même partout : un
 * transport, de quoi joindre le serveur, et de quoi l'authentifier. Ce qui diffère est
 * la façon de l'appliquer, pas de le décrire, et cette divergence vit dans les runners.
 *
 * Le modèle suit `McpServerConfigForProcessTransport` du SDK Claude, la seule variante
 * sérialisable de son union : les serveurs `sdk` portent une instance en mémoire et ne
 * peuvent ni se stocker ni se transporter.
 */

/**
 * Le nom voyage jusqu'au CLI, qui en préfixe les outils qu'il expose
 * (`mcp__<nom>__<outil>`). Un espace ou un point y casse la résolution d'outil côté
 * modèle, d'où la contrainte ici plutôt qu'un nettoyage silencieux à l'écriture.
 */
export const mcpServerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/)

const stdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * S'ajoute à l'environnement du serveur Sillage, ne le remplace pas : un serveur MCP
   * garde `HOME` et `PATH` sans qu'on ait à les recopier ici. Relevé sur les deux CLI.
   */
  env: z.record(z.string()).default({}),
})

const httpTransportSchema = z.object({
  /** `sse` est le transport historique, encore servi par des serveurs existants. */
  type: z.enum(['http', 'sse']),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
})

export const mcpTransportSchema = z.discriminatedUnion('type', [
  stdioTransportSchema,
  httpTransportSchema,
])
export type McpTransport = z.infer<typeof mcpTransportSchema>

export const mcpServerSchema = z.object({
  id: z.string(),
  name: mcpServerNameSchema,
  /**
   * Désactivé globalement : le serveur reste déclaré et gardé, mais n'est transmis à
   * aucun CLI. Évite d'avoir à le supprimer puis à le ressaisir pour l'éteindre le
   * temps d'un diagnostic.
   */
  enabled: z.boolean(),
  transport: mcpTransportSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type McpServer = z.infer<typeof mcpServerSchema>

/**
 * État d'un serveur tel que le CLI le rapporte.
 *
 * Vocabulaire unifié à partir des deux protocoles, qui ne décrivent pas la même chose :
 * Claude publie un statut par serveur, Codex publie un état de démarrage d'un côté et
 * un état d'authentification de l'autre. Les runners réduisent l'un et l'autre à ceci.
 */
export const mcpServerStateSchema = z.enum([
  'pending',
  'connected',
  'failed',
  /** Le serveur répond mais réclame une authentification que Sillage ne sait pas mener. */
  'needs-auth',
  'disabled',
])
export type McpServerState = z.infer<typeof mcpServerStateSchema>

export const mcpServerStatusSchema = z.object({
  name: z.string(),
  state: mcpServerStateSchema,
  /**
   * Outils réellement annoncés par le serveur, pas ceux qu'on espérait. C'est le seul
   * moyen pour l'utilisateur de vérifier qu'un serveur fait ce qu'il croit.
   */
  tools: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
  /**
   * Serveur venu du disque du CLI (`~/.claude.json`, `config.toml`, connecteurs
   * claude.ai) et non de Sillage. L'interface doit le montrer sans proposer de
   * l'éditer : Sillage n'en est pas propriétaire.
   */
  external: z.boolean().default(false),
})
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>
