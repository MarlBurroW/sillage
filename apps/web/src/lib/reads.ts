import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ConversationDto } from '@sillage/protocol'
import { api } from './api'
import { liveSeq, subscribeStatus } from './conversation-status'

/**
 * Il s'est passé quelque chose dans ce fil depuis la dernière visite du compte.
 *
 * Les deux `seq` sont retenus par leur maximum : celui de la liste REST date de son
 * chargement, celui du socket ne couvre que ce qui a été poussé depuis. Aucun des deux
 * n'est complet à lui seul.
 */
export function isUnread(conversation: ConversationDto, pushedSeq: number): boolean {
  return Math.max(conversation.lastNotableSeq, pushedSeq) > conversation.lastReadSeq
}

/**
 * Vrai si l'une de ces conversations a du nouveau.
 *
 * Instantané booléen plutôt qu'abonnement par ligne : un projet replié n'affiche aucune
 * ligne et n'a donc personne pour s'abonner à sa place. La valeur étant primitive,
 * `useSyncExternalStore` ne rend que lorsqu'elle bascule vraiment.
 */
export function useHasUnread(
  conversations: ConversationDto[],
  /** Le fil ouvert, qui ne compte pas : on est dedans. */
  openConversationId?: string,
): boolean {
  const snapshot = () =>
    conversations.some(
      (entry) => entry.id !== openConversationId && isUnread(entry, liveSeq(entry.id)),
    )
  return useSyncExternalStore(subscribeStatus, snapshot, snapshot)
}

/**
 * Un tour en cours pousse un `seq` toutes les quelques dizaines de millisecondes. Le
 * curseur part donc à intervalle fixe plutôt qu'à chaque changement : une conversation
 * longue produirait autant d'allers-retours que de jetons.
 */
const MARK_INTERVAL_MS = 2000

/**
 * Écrit dans le cache plutôt que d'invalider : la seule chose qui a changé est un entier
 * que le serveur vient de confirmer, et relire toute la liste pour lui ferait clignoter
 * la sidebar à chaque tour. La clé partielle attrape la liste globale comme celles par
 * projet, qui portent les mêmes objets.
 */
function applyReadCursor(
  queryClient: QueryClient,
  conversationId: string,
  lastReadSeq: number,
): void {
  queryClient.setQueriesData<ConversationDto[]>({ queryKey: ['conversations'] }, (list) =>
    list?.map((entry) => (entry.id === conversationId ? { ...entry, lastReadSeq } : entry)),
  )
}

/**
 * Tient à jour le curseur de lecture du fil ouvert.
 *
 * Quitter la page en plein tour n'envoie volontairement rien de plus : ce qui arrive
 * après le départ s'est bien produit pendant qu'on regardait ailleurs, et doit donc
 * revenir en non lu. Le dernier envoi date d'au plus `MARK_INTERVAL_MS`, ce qui borne
 * ce qu'on redécouvre à la poignée de secondes précédant la sortie.
 */
export function useTrackRead(conversationId: string | undefined, lastSeq: number): void {
  const queryClient = useQueryClient()

  // Le `seq` vit dans une ref : l'intervalle est monté une fois par conversation et doit
  // voir la valeur courante, pas celle capturée à sa création.
  const seqRef = useRef(lastSeq)
  seqRef.current = lastSeq

  // L'envoi aussi, pour que l'effet qui suit l'avancement du fil déclenche celui que la
  // conversation courante a installé, sans être remonté à chaque `seq`.
  const sendRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!conversationId) return

    let confirmed = 0
    let inFlight = false
    let attemptedAt = 0

    const send = async () => {
      // Un onglet en arrière-plan continue de battre. Sans ce test, laisser Sillage
      // ouvert sur une conversation pendant qu'un agent y travaille la marquerait lue
      // en continu, et c'est exactement la situation que le non-lu doit couvrir.
      if (document.visibilityState !== 'visible') return

      const seq = seqRef.current
      if (inFlight || seq <= confirmed) return
      // Le premier envoi part sans attendre, les suivants s'espacent : un tour en cours
      // pousse un `seq` toutes les quelques dizaines de millisecondes.
      if (attemptedAt > 0 && Date.now() - attemptedAt < MARK_INTERVAL_MS) return

      inFlight = true
      attemptedAt = Date.now()
      try {
        const result = await api.post<{ lastReadSeq: number }>(
          `/api/conversations/${conversationId}/read`,
          { seq },
        )
        // Avancé sur la réponse et non sur l'envoi : un POST perdu doit être rejoué au
        // battement suivant, sinon la conversation reste non lue pour toute la visite.
        confirmed = result.lastReadSeq
        applyReadCursor(queryClient, conversationId, result.lastReadSeq)
      } catch (error) {
        console.warn('[sillage] curseur de lecture non enregistré, nouvel essai :', error)
      } finally {
        inFlight = false
      }
    }

    sendRef.current = () => void send()
    const timer = window.setInterval(() => void send(), MARK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [conversationId, queryClient])

  // Ouvrir un fil doit l'éteindre tout de suite, pas au prochain battement : le journal
  // d'une longue conversation met plusieurs pages à arriver, et attendre en plus deux
  // secondes après la dernière donnait une ligne qui reste en gras sans raison visible.
  useEffect(() => {
    sendRef.current()
  }, [lastSeq])
}
