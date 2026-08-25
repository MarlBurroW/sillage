import type { JournalEntry, SillageEvent } from '@sillage/protocol'

/**
 * Regroupe les deltas d'une page de journal relue.
 *
 * Un tour livre son texte au token : une conversation de vingt-six mille événements en
 * porte neuf mille, qui ne disent rien de plus à la relecture que le texte qu'ils
 * composent. Le fold de rendu les paie pourtant cher, et deux fois : `messageIndex`
 * balaie le fil à l'envers pour retrouver la bulle à chaque fragment, et `replaceItem`
 * recopie la liste des éléments derrière lui. Le rejeu d'un fil long est quadratique, et
 * ce sont les deltas qui portent le carré.
 *
 * Les jeter serait plus simple, et c'est faux : un tour interrompu laisse des messages
 * dont aucun `message.completed` ne reprend le texte, et qui n'ont que leurs deltas.
 * Relevé sur trente et un messages en base, tous hors du dernier tour, donc hors de
 * portée d'une heuristique qui ne garderait que la fin du journal. Ils sont affichés
 * aujourd'hui ; les filtrer les effacerait sans le dire.
 *
 * Ils sont donc fusionnés, pas supprimés. `message.delta` et `thinking.delta` ajoutent
 * leur texte à un tampon (`chat-fold.ts`, `streamingText` et `streamingThinking`), donc
 * un delta unique portant la concaténation produit exactement le même état qu'eux tous.
 * Le regroupement se fait par message : chaque message a son propre tampon, et deux
 * messages entrelacés, un sous-agent qui écrit pendant le fil principal, n'interfèrent
 * pas. Seul l'ordre des fragments d'un même message compte, et il est conservé.
 *
 * Le fragment retenu porte le `seq` et le `ts` du premier de son groupe, parce que c'est
 * ce que le fold donne à la bulle qu'il crée et qu'il promet l'heure du début du
 * message. La page relue avance donc son curseur sur le dernier `seq` *lu*, pas sur le
 * dernier rendu, sans quoi une page entièrement fusionnée ferait reculer la lecture.
 *
 * La page rendue reste triée par `seq` croissant : un groupe occupe la place de son
 * premier fragment, et ces places sont créées dans l'ordre de lecture. Le garde
 * d'idempotence du client, qui compare chaque `seq` au dernier replié, en dépend.
 *
 * Le direct n'y passe pas : un delta fusionné n'a de sens que sur un journal déjà écrit.
 */

type TextDelta = Extract<SillageEvent, { type: 'message.delta' | 'thinking.delta' }>

/** Les deux seuls types dont le fold concatène le texte au lieu de le remplacer. */
function textDelta(event: SillageEvent): TextDelta | null {
  return event.type === 'message.delta' || event.type === 'thinking.delta' ? event : null
}

export function coalesceDeltas(entries: JournalEntry[]): JournalEntry[] {
  const merged: JournalEntry[] = []
  const groupAt = new Map<string, number>()

  for (const entry of entries) {
    const delta = textDelta(entry.event)
    if (!delta) {
      merged.push(entry)
      continue
    }

    const key = `${delta.type} ${delta.messageId}`
    const at = groupAt.get(key)

    if (at === undefined) {
      groupAt.set(key, merged.length)
      merged.push(entry)
      continue
    }

    const open = merged[at] as JournalEntry & { event: TextDelta }
    merged[at] = {
      ...open,
      event: {
        ...open.event,
        text: open.event.text + delta.text,
        // Même règle que le fold : le premier qui nomme un parent fait foi, et une
        // resynchronisation de transcript qui émet `null` ne doit pas l'effacer.
        parentToolCallId: open.event.parentToolCallId ?? delta.parentToolCallId,
      },
    }
  }

  return merged
}
