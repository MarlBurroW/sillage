import type { JournalEntry } from '@sillage/protocol'

/**
 * Réduit les sorties d'outils volumineuses d'une page de journal relue.
 *
 * Une conversation longue est d'abord un problème d'octets. Sur la plus lourde en base,
 * `tool.completed` pèse 22 Mo des 32 du journal, et 16,6 de ces 22 tiennent dans 317
 * sorties de plus de 8 ko, une seule portant 649 ko. Depuis l'extérieur, où la montante
 * de la maison est le facteur limitant, c'est ce transfert qui fait l'attente et non le
 * rejeu.
 *
 * La sortie complète n'est pas perdue : le journal la garde, et la carte de l'appel la
 * demande à l'ouverture (`GET /api/conversations/:id/tools/:toolCallId/output`).
 *
 * `output` est un `unknown` du schéma, et les formes relevées en base sont hétérogènes :
 * des chaînes, des blocs de contenu, des images en base64, des tableaux de diffs. Une
 * chaîne se coupe et garde un aperçu lisible ; le reste ne se coupe pas sans produire du
 * JSON invalide ou une image tronquée, donc il est retiré. La carte n'affiche de toute
 * façon rien tant qu'elle est repliée, et l'ouvrir déclenche la demande du corps entier.
 */

/** Au-delà, une sortie est renvoyée en aperçu. Assez pour lire un résultat ordinaire. */
const MAX_OUTPUT_BYTES = 8192

export function previewToolOutputs(entries: JournalEntry[]): JournalEntry[] {
  return entries.map((entry) => {
    if (entry.event.type !== 'tool.completed') return entry

    const output = entry.event.output
    const serialized = output === undefined ? '' : JSON.stringify(output)
    const bytes = Buffer.byteLength(serialized)
    if (bytes <= MAX_OUTPUT_BYTES) return entry

    return {
      ...entry,
      event: {
        ...entry.event,
        output: typeof output === 'string' ? output.slice(0, MAX_OUTPUT_BYTES) : null,
        outputBytes: bytes,
      },
    }
  })
}
