import { z } from 'zod'

/**
 * Comptes Claude supplémentaires, par utilisateur.
 *
 * Le CLI ne connaît qu'une connexion par dossier de configuration, celle de `/login`.
 * Pour en tenir plusieurs sans dédoubler ce dossier (réglages, transcripts, mémoire),
 * Sillage retient un jeton OAuth longue durée par compte, celui que `claude setup-token`
 * imprime, et le passe à la session dans `CLAUDE_CODE_OAUTH_TOKEN` : le CLI le fait
 * passer devant sa connexion enregistrée (sondé sur 2.1.296).
 *
 * Comme les credentials git, un jeton s'écrit et ne se relit jamais par l'API, et il
 * appartient à un compte Sillage et non à l'instance : c'est l'abonnement de quelqu'un.
 */

export const claudeAccountSchema = z.object({
  id: z.string(),
  /** Nom choisi par l'utilisateur (« Perso », « Boulot ») : le jeton ne dit pas à qui il est. */
  label: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ClaudeAccount = z.infer<typeof claudeAccountSchema>

export const claudeAccountLabelSchema = z.string().trim().min(1).max(60)

/**
 * Ce que `claude setup-token` imprime : un jeton `sk-ant-oat01-…`. Le préfixe est la
 * seule vérification possible sans dépenser un tour, le CLI ne sachant rien dire d'un
 * jeton tant qu'une requête de modèle ne l'a pas présenté.
 */
export const claudeOauthTokenSchema = z
  .string()
  .trim()
  .regex(/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/, 'Un jeton de `claude setup-token`, qui commence par sk-ant-oat01-.')

export const createClaudeAccountBodySchema = z.object({
  label: claudeAccountLabelSchema,
  token: claudeOauthTokenSchema,
})

/** Renommer, remplacer le jeton expiré, ou les deux : chaque champ est facultatif. */
export const updateClaudeAccountBodySchema = z
  .object({
    label: claudeAccountLabelSchema.optional(),
    token: claudeOauthTokenSchema.optional(),
  })
  .refine((body) => body.label !== undefined || body.token !== undefined, {
    message: 'Rien à modifier.',
  })

export interface ClaudeAccountListDto {
  accounts: ClaudeAccount[]
}
