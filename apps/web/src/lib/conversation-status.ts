import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConversationDto, ConversationMetrics, ConversationStatus } from '@sillage/protocol'
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
// Les fins observées restent disponibles quand on change de projet dans la sidebar.
const settledAt = new Map<string, number>()
export function liveSettledAt(conversationId: string): number {
  return settledAt.get(conversationId) ?? 0
}
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
    a.turnCount === b.turnCount &&
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
 * Dernier `seq` notable poussé pour ce fil, 0 tant qu'on n'a rien reçu.
 *
 * Le 0 se lit « rien à dire », pas « journal vide » : l'appelant compare avec le
 * `lastNotableSeq` de la liste REST et garde le plus grand des deux.
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

export function liveStatus(conversationId: string): ConversationStatus | undefined {
  return statuses.get(conversationId)
}

export function liveBackground(conversationId: string): number {
  return backgrounds.get(conversationId) ?? 0
}

/**
 * Fenêtre où les signaux de liste se regroupent. Un même geste en produit parfois
 * plusieurs : un glissement réécrit l'ordre, l'onglet qui l'a fait relit déjà de son
 * côté. Une seule relecture suffit pour la rafale.
 */
const LISTS_REFRESH_DELAY_MS = 150

/** L'indicateur tourne au moins ce temps : plus bref, il clignote sans qu'on le lise. */
const MIN_REFRESH_MS = 500

/**
 * Branche l'onglet sur le flux de statuts. Monté par la sidebar, qui est la seule vue
 * à afficher des conversations qu'elle n'a pas ouvertes.
 */
export function useStatusFeed(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    let listsTimer: number | null = null

    const stop = wsClient.watchStatuses({
      onStatus: ({
        conversationId,
        status,
        background,
        loops: loopCount,
        lastNotableSeq,
        metrics: pushed,
      }) => {
        // Une session créée ailleurs doit rejoindre l'overview sans rechargement.
        // Le premier statut suffit ; les jetons suivants ne relancent pas la requête.
        if (!statuses.has(conversationId)) {
          const known = queryClient.getQueryData<ConversationDto[]>(['conversations', 'all'])
          if (known && !known.some((entry) => entry.id === conversationId)) {
            void queryClient.invalidateQueries({ queryKey: ['conversations'] })
            // Un fil inconnu est peut-être un tir planifié qui vient de partir.
            void queryClient.invalidateQueries({ queryKey: ['schedules'] })
          }
        }
        const metricsChanged = !sameMetrics(metrics.get(conversationId), pushed)
        const changed =
          metricsChanged ||
          statuses.get(conversationId) !== status ||
          (backgrounds.get(conversationId) ?? 0) !== background ||
          (loops.get(conversationId) ?? 0) !== loopCount ||
          (seqs.get(conversationId) ?? 0) !== lastNotableSeq
        if (!changed) return
        const previous = statuses.get(conversationId)
        const wasBusy = previous === 'running' || previous === 'awaiting_input' || (backgrounds.get(conversationId) ?? 0) > 0
        const busy = status === 'running' || status === 'awaiting_input' || background > 0
        if (wasBusy && !busy) settledAt.set(conversationId, Date.now())
        if (busy) settledAt.delete(conversationId)
        statuses.set(conversationId, status)
        backgrounds.set(conversationId, background)
        loops.set(conversationId, loopCount)
        seqs.set(conversationId, lastNotableSeq)
        // Seulement si le contenu a bougé : ranger l'objet reçu à chaque poussée
        // rerendrait toute ligne détaillée pour des chiffres identiques.
        if (metricsChanged) metrics.set(conversationId, pushed)
        emit()
      },
      onResync: () => {
        // Ce qui a été poussé avant la coupure ne fait plus autorité : la liste relue
        // reprend la main, et les prochaines poussées repartent d'elle.
        statuses.clear()
        settledAt.clear()
        backgrounds.clear()
        loops.clear()
        seqs.clear()
        metrics.clear()
        emit()
        void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      },
      onListsChanged: () => {
        if (listsTimer !== null) return
        listsTimer = window.setTimeout(() => {
          listsTimer = null
          void queryClient.invalidateQueries({ queryKey: ['conversations'] })
          void queryClient.invalidateQueries({ queryKey: ['projects'] })
          void queryClient.invalidateQueries({ queryKey: ['schedules'] })
          // L'en-tête du fil ouvert aussi : renommé ou supprimé ailleurs, il doit le
          // montrer sans attendre qu'on en sorte.
          void queryClient.invalidateQueries({ queryKey: ['conversation'] })
        }, LISTS_REFRESH_DELAY_MS)
      },
    })

    return () => {
      stop()
      if (listsTimer !== null) clearTimeout(listsTimer)
    }
  }, [queryClient])
}

/**
 * Relit ce qui a vieilli, sans rien vider, aux moments où l'on va regarder la liste
 * sans que rien ne l'ait signalé : l'ouverture du tiroir sur téléphone, qui reste monté
 * hors de l'écran et ne se relit donc jamais de lui-même.
 */
export function useRevalidateLists(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    wsClient.check()
    void queryClient.refetchQueries({ queryKey: ['conversations'], type: 'active', stale: true })
  }, [queryClient])
}

/**
 * Rafraîchissement demandé à la main, par le bouton ou le geste de la sidebar.
 *
 * Rien de ce qui est affiché n'est cru sur parole : le socket est remplacé par un neuf,
 * ce qui vide les statuts poussés et réabonne le fil ouvert depuis son curseur, puis
 * les listes sont relues. C'est le chemin d'une reconnexion, pris sans attendre d'avoir
 * constaté la coupure.
 */
export function useRefreshLists(): { refreshing: boolean; refresh: () => void } {
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  // Une ref et non l'état : deux gestes dans le même rendu verraient tous deux `false`.
  const running = useRef(false)

  const refresh = useCallback(() => {
    if (running.current) return
    running.current = true
    setRefreshing(true)

    const work = async () => {
      await wsClient.resync()
      // `cancelRefetch: false` : la reconnexion vient de relancer la liste, cette
      // lecture-là est rejointe plutôt qu'interrompue pour une autre identique.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['conversations'], type: 'active' }, { cancelRefetch: false }),
        queryClient.refetchQueries({ queryKey: ['projects'], type: 'active' }, { cancelRefetch: false }),
      ])
    }

    const minimum = new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_MS))
    void Promise.all([work(), minimum]).finally(() => {
      running.current = false
      setRefreshing(false)
    })
  }, [queryClient])

  return { refreshing, refresh }
}
