import { z } from 'zod'
import { agentKindSchema } from './events.js'

/**
 * Consommation du compte, telle que le CLI la déclare.
 *
 * Volontairement une **liste** de fenêtres et non un jeu de champs nommés : les CLI en
 * ajoutent régulièrement côté serveur, sans mise à jour du client. La sortie de Fable a
 * fait apparaître une fenêtre dédiée du jour au lendemain, et la sonde du CLI installé
 * montre aujourd'hui une douzaine de clés dont la plupart sont encore nulles et portent
 * des noms de code. Figer une liste ici reviendrait à devoir rebuilder à chaque
 * nouveauté, et à masquer en silence tout ce qui n'aurait pas été prévu.
 */

export const usageWindowSchema = z.object({
  /** Clé d'origine côté CLI, stable, utilisée comme identité de rendu. */
  id: z.string(),
  label: z.string(),
  /** Part consommée, de 0 à 1. Null quand le CLI ne la fournit pas. */
  utilization: z.number().nullable(),
  /** Fin de la fenêtre, en millisecondes. Null si inconnue. */
  resetsAt: z.number().nullable(),
})
export type UsageWindow = z.infer<typeof usageWindowSchema>

/**
 * Crédits facturés au-delà du forfait. Les deux CLI n'en donnent pas la même chose :
 * Claude un pourcentage et des montants, Codex un solde. `detail` est donc un texte
 * déjà mis en forme, plutôt qu'un modèle monétaire commun qui n'existe pas.
 */
export const usageCreditsSchema = z.object({
  label: z.string(),
  utilization: z.number().nullable(),
  detail: z.string().nullable(),
  enabled: z.boolean(),
})

export const agentUsageSchema = z.object({
  agent: agentKindSchema,
  /** Formule déclarée par le CLI (`max`, `plus`...). Null en facturation à l'usage. */
  plan: z.string().nullable(),
  /**
   * Faux quand les limites de forfait ne s'appliquent pas : clé API, Bedrock, Vertex.
   * Les fenêtres sont alors vides, et ce n'est pas une panne.
   */
  limitsAvailable: z.boolean(),
  windows: z.array(usageWindowSchema),
  credits: usageCreditsSchema.nullable(),
  fetchedAt: z.number(),
})
export type AgentUsage = z.infer<typeof agentUsageSchema>
