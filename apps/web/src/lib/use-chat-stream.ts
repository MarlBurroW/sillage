import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentConfig, ConversationStatus, SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState, isAwaitingUser, type ChatState } from './chat-fold'
import { fetchJournal } from './conversations'
import { wsClient } from './ws-client'

/** Les deltas sont appliqués par lots : un rendu par token effondre le framerate mobile. */
const FLUSH_INTERVAL_MS = 60

export interface ChatStream {
  state: ChatState
  status: ConversationStatus
  connected: boolean
  /** Un process CLI tourne encore pour cette conversation. Null tant qu'on l'ignore. */
  warm: boolean | null
  /**
   * Configuration sous laquelle le CLI tourne vraiment, `null` à froid ou avant le
   * premier statut poussé. Elle diverge de celle enregistrée tant qu'un réglage que le
   * CLI ne sait pas changer en vol attend son redémarrage.
   */
  appliedConfig: AgentConfig | null
  /**
   * Le journal n'a pas fini d'être rejoué. Vrai jusqu'à la dernière page, et non
   * jusqu'à la première : c'est ce qui permet à la page de garder le fil masqué le
   * temps qu'il se construise, plutôt que de le montrer pousser par paquets.
   */
  loading: boolean
  error: string | null
}

export function useChatStream(
  conversationId: string | undefined,
  initialStatus: ConversationStatus,
): ChatStream {
  const [state, setState] = useState<ChatState>(emptyChatState)
  const [status, setStatus] = useState<ConversationStatus>(initialStatus)
  const [connected, setConnected] = useState(false)
  const [warm, setWarm] = useState<boolean | null>(null)
  const [appliedConfig, setAppliedConfig] = useState<AgentConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  // L'état vit dans une ref : le fold doit voir la valeur courante, pas celle
  // capturée à la création de l'abonnement.
  const stateRef = useRef<ChatState>(emptyChatState())
  const pending = useRef<{ seq: number; ts: number; event: SillageEvent }[]>([])
  const flushTimer = useRef<number | null>(null)
  /**
   * Dernier `seq` reçu, qui n'est pas `state.lastSeq`.
   *
   * Le serveur fusionne les deltas d'une page sous le `seq` du premier fragment de
   * chaque message, donc l'état s'arrête au dernier `seq` *rendu*, en deçà du dernier
   * lu. Reprendre sur l'état ferait redemander les fragments déjà fusionnés, que le
   * garde d'idempotence ne rattraperait pas puisque leur `seq` est plus grand : leur
   * texte s'ajouterait une seconde fois au message en cours.
   */
  const cursor = useRef(0)

  useEffect(() => {
    setStatus(initialStatus)
  }, [initialStatus])

  useEffect(() => {
    if (!conversationId) return

    let cancelled = false
    stateRef.current = emptyChatState()
    pending.current = []
    cursor.current = 0
    setState(stateRef.current)
    setLoading(true)
    setError(null)

    const flush = () => {
      flushTimer.current = null
      if (pending.current.length === 0) return

      let next = stateRef.current
      for (const { seq, ts, event } of pending.current) {
        // Un événement déjà appliqué (rejeu après rechargement REST) est ignoré :
        // c'est ce qui garantit qu'une reconnexion ne duplique jamais le fil.
        if (seq <= next.lastSeq) continue
        next = applyEvent(next, seq, ts, event)
      }
      pending.current = []
      stateRef.current = next
      setState(next)
    }

    const scheduleFlush = () => {
      if (flushTimer.current !== null) return
      flushTimer.current = window.setTimeout(flush, FLUSH_INTERVAL_MS)
    }

    const enqueue = (seq: number, ts: number, event: SillageEvent) => {
      cursor.current = Math.max(cursor.current, seq)
      pending.current.push({ seq, ts, event })
      scheduleFlush()
    }

    const loadFromRest = async () => {
      try {
        const read = await fetchJournal(conversationId, cursor.current, (entries) => {
          if (cancelled) return

          for (const entry of entries) enqueue(entry.seq, entry.ts, entry.event)
          // Replié page par page plutôt qu'en un bloc à la fin : le fil reste masqué
          // pendant ce temps, mais étaler le fold laisse la main à l'interface entre
          // deux pages, ce qui est ce qui compte sur une conversation longue.
          flush()
        })
        if (cancelled) return

        cursor.current = Math.max(cursor.current, read)
        wsClient.setCursor(conversationId, cursor.current)
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Chargement du fil impossible.')
        setLoading(false)
      }
    }

    // Chargement initial d'abord, abonnement ensuite : le socket reprend exactement
    // là où l'historique s'arrête.
    void loadFromRest().then(() => {
      if (cancelled) return

      unsubscribe = wsClient.subscribe(conversationId, cursor.current, {
        onEvent: (seq, ts, event) => enqueue(seq, ts, event),
        onStatus: (next, isWarm, applied) => {
          setStatus(next)
          setWarm(isWarm)
          setAppliedConfig(applied)
        },
        onTitle: () => {
          // Le titre vit dans la ligne de conversation, pas dans le journal : il faut
          // relire, ici la sidebar comme l'en-tête.
          void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
          void queryClient.invalidateQueries({ queryKey: ['conversations'] })
        },
        onCatchupNeeded: () => void loadFromRest(),
        onConnectionChange: (isConnected) => {
          setConnected(isConnected)
          // Une reconnexion peut avoir manqué des événements si le socket a été tué
          // sans que le serveur s'en aperçoive : on rejoue depuis le curseur.
          if (isConnected) void loadFromRest()
        },
      })
    })

    let unsubscribe: (() => void) | null = null
    return () => {
      cancelled = true
      unsubscribe?.()
      if (flushTimer.current !== null) clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
  }, [conversationId, queryClient])

  return {
    state,
    status: reconcileStatus(status, state),
    connected,
    warm,
    appliedConfig,
    loading,
    error,
  }
}

/**
 * Réconcilie le statut poussé avec ce que dit le journal (invariant I2).
 *
 * Le journal ne peut qu'ajouter de l'occupation, jamais en retirer : une sollicitation
 * ouverte ou un tour en cours priment sur un statut qui n'est pas encore arrivé, mais
 * un journal qui paraît au repos ne fait pas taire le serveur.
 *
 * Il le faisait, et ramenait tout `running` poussé à `idle` : la sidebar montrait la
 * conversation en cours pendant que l'en-tête n'affichait rien et que la barre de saisie
 * gardait son bouton d'envoi. Le statut du serveur est la valeur en base, poussée à
 * chaque transition, renvoyée en instantané à chaque abonnement, et remise à
 * `interrupted` au démarrage du daemon pour les conversations qu'un arrêt brutal avait
 * laissées en cours. Rien ne justifie de le contredire.
 */
function reconcileStatus(pushed: ConversationStatus, state: ChatState): ConversationStatus {
  if (state.items.some(isAwaitingUser)) return 'awaiting_input'
  if (state.turnRunning) return 'running'
  return pushed
}
