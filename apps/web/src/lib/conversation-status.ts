import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConversationStatus } from '@sillage/protocol'
import { wsClient } from './ws-client'

/**
 * Statuts poussés par le socket, hors du cache REST.
 *
 * La liste des conversations est une photo prise au chargement : elle ne dit rien des
 * transitions qui suivent, et la pastille « en cours » de la sidebar restait donc
 * figée jusqu'au prochain rafraîchissement, dans un sens comme dans l'autre. Ces
 * statuts-là se superposent à la photo sans la remplacer : le socket ne pousse que ce
 * qui change, il n'a pas de valeur de départ à donner.
 */

const statuses = new Map<string, ConversationStatus>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

/** Statut temps réel, ou undefined tant qu'aucun n'a été poussé pour ce fil. */
export function useLiveStatus(conversationId: string): ConversationStatus | undefined {
  return useSyncExternalStore(
    subscribe,
    () => statuses.get(conversationId),
    () => undefined,
  )
}

/**
 * Branche l'onglet sur le flux de statuts. Monté par la sidebar, qui est la seule vue
 * à afficher des conversations qu'elle n'a pas ouvertes.
 */
export function useStatusFeed(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    return wsClient.watchStatuses({
      onStatus: (conversationId, status) => {
        if (statuses.get(conversationId) === status) return
        statuses.set(conversationId, status)
        emit()
      },
      onResync: () => {
        // Ce qui a été poussé avant la coupure ne fait plus autorité : la liste relue
        // reprend la main, et les prochaines poussées repartent d'elle.
        statuses.clear()
        emit()
        void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      },
    })
  }, [queryClient])
}
