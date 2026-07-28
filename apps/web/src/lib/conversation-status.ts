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
/**
 * Travaux de fond par conversation, dans une table à part.
 *
 * Séparée des statuts plutôt que fondue dans un objet : `useSyncExternalStore` compare
 * les instantanés par identité, et un objet recomposé à chaque lecture rendrait sans
 * fin. Deux tables de valeurs primitives évitent le mémo.
 */
const backgrounds = new Map<string, number>()
/** Boucles armées par conversation. Table à part pour la même raison. */
const loops = new Map<string, number>()
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
 * Nombre de travaux de fond en cours, 0 tant que rien n'a été poussé.
 *
 * Toujours 0 pour une conversation froide : ces travaux vivent dans le process du CLI.
 */
export function useLiveBackground(conversationId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => backgrounds.get(conversationId) ?? 0,
    () => 0,
  )
}

/**
 * Nombre de boucles armées, 0 tant que rien n'a été poussé.
 *
 * Toujours 0 pour une conversation froide : une tâche planifiée ne tire que pendant
 * que le CLI tourne.
 */
export function useLiveLoops(conversationId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => loops.get(conversationId) ?? 0,
    () => 0,
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
      onStatus: (conversationId, status, _warm, background, loopCount) => {
        const changed =
          statuses.get(conversationId) !== status ||
          (backgrounds.get(conversationId) ?? 0) !== background ||
          (loops.get(conversationId) ?? 0) !== loopCount
        if (!changed) return
        statuses.set(conversationId, status)
        backgrounds.set(conversationId, background)
        loops.set(conversationId, loopCount)
        emit()
      },
      onResync: () => {
        // Ce qui a été poussé avant la coupure ne fait plus autorité : la liste relue
        // reprend la main, et les prochaines poussées repartent d'elle.
        statuses.clear()
        backgrounds.clear()
        loops.clear()
        emit()
        void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      },
    })
  }, [queryClient])
}
