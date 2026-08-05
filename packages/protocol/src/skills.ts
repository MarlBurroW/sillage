import { z } from 'zod'

/**
 * Les compétences qu'un CLI met à disposition de la session.
 *
 * Codex les publie par `skills/list` et les référence en `$nom`. Ce n'est pas une
 * commande : rien ne s'exécute côté client, la compétence rejoint le message comme un
 * élément d'entrée à part entière (`{type:'skill'}`), au même titre qu'une mention de
 * fichier. Claude, lui, expose les siennes parmi ses commandes en `/` et ne publie
 * rien ici.
 */
export const agentSkillSchema = z.object({
  /** Sans le `$`, tel que le CLI le nomme, et seule clé de résolution à l'envoi. */
  name: z.string(),
  description: z.string(),
})

export type AgentSkillDto = z.infer<typeof agentSkillSchema>

/**
 * Plafond des compétences d'un message, aligné sur celui des mentions et pour la même
 * raison : chacune injecte un document entier dans le contexte.
 */
export const MAX_SKILLS_PER_MESSAGE = 20
