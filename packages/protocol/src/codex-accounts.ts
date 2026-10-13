import { z } from 'zod'

/**
 * Comptes Codex supplémentaires, par utilisateur.
 *
 * Codex ne tient qu'une connexion par `CODEX_HOME`, dans son `auth.json`. Sillage donne
 * donc à chaque compte supplémentaire son propre home, où seul `auth.json` est réel :
 * tout le reste (config.toml, sessions, skills, mémoires) est un lien vers le home de
 * l'utilisateur, pour que le compte ne change que l'abonnement qui paie, pas les
 * réglages ni les threads (sondé sur codex-cli 0.162.1 : un thread se reprend d'un
 * home à l'autre).
 *
 * Sillage ne stocke aucun secret lui-même : la connexion se fait par l'app-server
 * lancé dans ce home, par code d'appareil ou par clé API, et c'est Codex qui écrit son
 * `auth.json` et le rafraîchit.
 */

export const codexAccountLabelSchema = z.string().trim().min(1).max(60)

export const codexAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** `pending` tant qu'aucune connexion n'a abouti dans son home. */
  status: z.enum(['pending', 'ready']),
  /** Comment le home est connecté, tel que Codex le déclare ; null tant qu'il ne l'est pas. */
  authMode: z.enum(['chatgpt', 'apiKey']).nullable(),
  /** Courriel et forfait lus après la connexion ChatGPT, null pour une clé API. */
  email: z.string().nullable(),
  planType: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type CodexAccount = z.infer<typeof codexAccountSchema>

export const createCodexAccountBodySchema = z.object({ label: codexAccountLabelSchema })
export const updateCodexAccountBodySchema = z.object({ label: codexAccountLabelSchema })

/**
 * Deux façons de connecter un home : le code d'appareil, pour un abonnement ChatGPT
 * sans navigateur sur le serveur, et une clé API. Le flux navigateur classique est
 * écarté : son retour se fait sur `localhost:1455` du serveur, que le navigateur de
 * l'utilisateur ne joint pas.
 */
export const startCodexLoginBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('deviceCode') }),
  z.object({ type: z.literal('apiKey'), apiKey: z.string().trim().min(1) }),
])

/**
 * Où en est la connexion d'un compte. `pending` porte ce que l'utilisateur doit faire
 * de son côté : ouvrir l'URL et saisir le code. `failed` garde le motif donné par Codex.
 */
export interface CodexLoginStatusDto {
  state: 'idle' | 'pending' | 'done' | 'failed'
  verificationUrl: string | null
  userCode: string | null
  error: string | null
}

export interface CodexAccountListDto {
  accounts: CodexAccount[]
}
