import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConversationMetrics, ConversationStatus } from '@sillage/protocol'
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
/** Dernier `seq` connu par conversation, pour le non-lu. Table à part, même raison. */
const seqs = new Map<string, number>()
/**
 * Relevés de volume par conversation, pour le mode détaillé de la sidebar.
 *
 * Seule table à porter un objet, ce que la comparaison par identité de
 * `useSyncExternalStore` interdit de recomposer à la lecture : l'objet reçu est rangé
 * tel quel, et n'est remplacé que lorsqu'un de ses champs a bougé.
 */
const metrics = new Map<string, ConversationMetrics>()
const listeners = new Set<() => void>()

/**
 * Exporté pour les vues qui agrègent plusieurs conversations : elles ne peuvent pas
 * s'abonner ligne par ligne et composent leur propre instantané à partir de `liveSeq`.
 */
export function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

function sameMetrics(a: ConversationMetrics | undefined, b: ConversationMetrics): boolean {
  return (
    a !== undefined &&
    a.exchangeCount === b.exchangeCount &&
    a.journalBytes === b.journalBytes &&
    a.model === b.model &&
    a.context?.usedTokens === b.context?.usedTokens &&
    a.context?.maxTokens === b.context?.maxTokens
  )
}

/** Statut temps réel, ou undefined tant qu'aucun n'a été poussé pour ce fil. */
export function useLiveStatus(conversationId: string): ConversationStatus | undefined {
  return useSyncExternalStore(
    subscribeStatus,
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
    subscribeStatus,
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
    subscribeStatus,
    () => loops.get(conversationId) ?? 0,
    () => 0,
  )
}

/**
 * Dernier `seq` poussé pour ce fil, 0 tant qu'on n'a rien reçu.
 *
 * Le 0 se lit « rien à dire », pas « journal vide » : l'appelant compare avec le
 * `lastSeq` de la liste REST et garde le plus grand des deux.
 */
export function useLiveSeq(conversationId: string): number {
  return useSyncExternalStore(
    subscribeStatus,
    () => seqs.get(conversationId) ?? 0,
    () => 0,
  )
}

/**
 * Derniers relevés poussés, `undefined` tant que rien n'est arrivé pour ce fil.
 *
 * L'appelant garde alors ceux de la liste REST : le socket ne pousse que ce qui change,
 * il n'a pas de valeur de départ à donner.
 */
export function useLiveMetrics(conversationId: string): ConversationMetrics | undefined {
  return useSyncExternalStore(
    subscribeStatus,
    () => metrics.get(conversationId),
    () => undefined,
  )
}

/** Lecture directe, pour les instantanés composés par les abonnés de `subscribeStatus`. */
export function liveSeq(conversationId: string): number {
  return seqs.get(conversationId) ?? 0
}

/**
 * Branche l'onglet sur le flux de statuts. Monté par la sidebar, qui est la seule vue
 * à afficher des conversations qu'elle n'a pas ouvertes.
 */
export function useStatusFeed(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    return wsClient.watchStatuses({
      onStatus: ({
        conversationId,
        status,
        background,
        loops: loopCount,
        lastSeq,
        metrics: pushed,
      }) => {
        const metricsChanged = !sameMetrics(metrics.get(conversationId), pushed)
        const changed =
          metricsChanged ||
          statuses.get(conversationId) !== status ||
          (backgrounds.get(conversationId) ?? 0) !== background ||
          (loops.get(conversationId) ?? 0) !== loopCount ||
          (seqs.get(conversationId) ?? 0) !== lastSeq
        if (!changed) return
        statuses.set(conversationId, status)
        backgrounds.set(conversationId, background)
        loops.set(conversationId, loopCount)
        seqs.set(conversationId, lastSeq)
        // Seulement si le contenu a bougé : ranger l'objet reçu à chaque poussée
        // rerendrait toute ligne détaillée pour des chiffres identiques.
        if (metricsChanged) metrics.set(conversationId, pushed)
        emit()
      },
      onResync: () => {
        // Ce qui a été poussé avant la coupure ne fait plus autorité : la liste relue
        // reprend la main, et les prochaines poussées repartent d'elle.
        statuses.clear()
        backgrounds.clear()
        loops.clear()
        seqs.clear()
        metrics.clear()
        emit()
        void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      },
    })
  }, [queryClient])
}
