import { z } from 'zod'

/**
 * Dépôt de secrets de l'instance.
 *
 * Un secret est écrit une fois et ne se relit jamais par l'API : les routes ne
 * renvoient que des noms et des dates. C'est ce qui distingue ce dépôt d'un simple
 * champ de configuration, et c'est aussi ce qui impose de remplacer un secret plutôt
 * que de le corriger, puisque l'interface ne peut pas afficher sa valeur actuelle.
 *
 * Les valeurs ne sont déchiffrées que côté serveur, au lancement d'un runner, pour
 * être posées dans l'environnement ou les en-têtes d'un serveur MCP. Elles ne
 * traversent jamais le WebSocket ni le journal.
 */

/**
 * Le nom sert d'identifiant dans `{{secret.NOM}}` : ce qu'on y accepte doit pouvoir
 * s'écrire dans un motif sans échappement ni ambiguïté de fin de jeton.
 */
export const secretNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+$/)

/** Ce que l'API rend d'un secret : tout sauf sa valeur. */
export const secretSchema = z.object({
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /**
   * Où ce secret est employé, calculé à la lecture.
   *
   * Sans ça, supprimer un secret revient à parier : rien à l'écran ne dit qu'un
   * serveur MCP en dépend, et la panne n'apparaît qu'au prochain lancement.
   */
  usedBy: z.array(z.string()).default([]),
})
export type Secret = z.infer<typeof secretSchema>

export const putSecretBodySchema = z.object({
  name: secretNameSchema,
  value: z.string().min(1),
})

export interface SecretListDto {
  secrets: Secret[]
}

/** Motif de substitution, reconnu dans les valeurs d'environnement et d'en-têtes. */
const SECRET_PATTERN = /\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/g

/** Noms de secrets référencés par un texte, sans doublon et dans l'ordre de lecture. */
export function referencedSecrets(text: string): string[] {
  return [...new Set([...text.matchAll(SECRET_PATTERN)].map((match) => match[1] as string))]
}

/**
 * Remplace les motifs par leur valeur.
 *
 * `resolve` rend `undefined` pour un secret absent, et c'est l'appelant qui décide
 * quoi en faire : ici on ne substitue rien et on laisse le nom manquant remonter, un
 * en-tête d'authentification vidé en silence produisant une erreur distante que rien
 * ne relie à sa cause.
 */
export function applySecrets(
  text: string,
  resolve: (name: string) => string | undefined,
): { text: string; missing: string[] } {
  const missing: string[] = []
  const out = text.replace(SECRET_PATTERN, (whole, name: string) => {
    const value = resolve(name)
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return value
  })
  return { text: out, missing }
}
