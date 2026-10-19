import { z } from 'zod'

/**
 * Comptes Grok Build supplémentaires, par utilisateur.
 *
 * Grok ne tient qu'une connexion par `GROK_HOME`, dans son `auth.json`. Comme pour Codex,
 * Sillage donne à chaque compte supplémentaire son propre home, où seuls la connexion et
 * ce qui dépend du compte (catalogue de modèles, réglages distants) sont réels : le reste
 * (sessions, config.toml, mémoire, skills) est un lien vers le home de l'utilisateur, pour
 * que le compte ne change que l'abonnement qui paie, pas les réglages ni les sessions.
 *
 * Sillage ne stocke aucun secret lui-même : la connexion se fait par Grok lancé dans ce
 * home, par code d'appareil (`grok login --device-auth`) ou par clé API, et c'est Grok qui
 * écrit son `auth.json`.
 */

export const grokAccountLabelSchema = z.string().trim().min(1).max(60)

export const grokAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** `pending` tant qu'aucune connexion n'a abouti dans son home. */
  status: z.enum(['pending', 'ready']),
  /** `grok` pour un abonnement connecté par grok.com, `apiKey` pour une clé xAI. */
  authMode: z.enum(['grok', 'apiKey']).nullable(),
  /** Courriel lu à la connexion grok.com, null pour une clé API. */
  email: z.string().nullable(),
  /** Formule annoncée par la facturation de Grok (« X Premium », « SuperGrok »…). */
  plan: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type GrokAccount = z.infer<typeof grokAccountSchema>

export const createGrokAccountBodySchema = z.object({ label: grokAccountLabelSchema })
export const updateGrokAccountBodySchema = z.object({ label: grokAccountLabelSchema })

/**
 * Deux façons de connecter un home : le code d'appareil, pour un abonnement sans
 * navigateur sur le serveur, et une clé API xAI.
 */
export const startGrokLoginBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('deviceCode') }),
  z.object({ type: z.literal('apiKey'), apiKey: z.string().trim().min(1) }),
])

/** Où en est la connexion d'un compte, même forme que celle des comptes Codex. */
export interface GrokLoginStatusDto {
  state: 'idle' | 'pending' | 'done' | 'failed'
  verificationUrl: string | null
  userCode: string | null
  error: string | null
}

export interface GrokAccountListDto {
  accounts: GrokAccount[]
}
