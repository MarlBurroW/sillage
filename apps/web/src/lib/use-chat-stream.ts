import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentConfig, ConversationStatus, SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState, isAwaitingUser, type ChatState } from './chat-fold'
import { fetchJournal } from './conversations'
import { wsClient } from './ws-client'
import { locale } from './i18n'

interface JournalSnapshot {
  state: ChatState
  cursor: number
}

const SNAPSHOT_KEY = 'chat-journal-snapshot'
const MAX_SNAPSHOTS = 4

/** Batch deltas: rendering once per token destroys mobile frame rates. */
const FLUSH_INTERVAL_MS = 60

export interface ChatStream {
  state: ChatState
  status: ConversationStatus
  connected: boolean
  /** A CLI process is still running for this conversation. Null while unknown. */
  warm: boolean | null
  /**
   * Configuration actually used by the CLI, `null` before startup or the first status push. Differs
   * from saved settings while a setting that cannot change live awaits a restart.
   */
  appliedConfig: AgentConfig | null
  /**
   * Log replay is incomplete. True until the last page, not the first, allowing the page to hide
   * the thread while it is built instead of showing it grow in batches.
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

  // Keep state in a ref: the fold must see its current value rather than the one captured when subscribing.
  const stateRef = useRef<ChatState>(emptyChatState())
  const pending = useRef<{ seq: number; ts: number; event: SillageEvent }[]>([])
  const flushTimer = useRef<number | null>(null)
  /**
   * Latest received `seq`, distinct from `state.lastSeq`. The server merges page deltas under each
   * message's first fragment sequence, so state stops at the last returned sequence before the last
   * read one. Resuming from state would request already-merged fragments again; their larger
   * sequences bypass the idempotence guard and duplicate text in the current message.
   */
  const cursor = useRef(0)

  useEffect(() => {
    setStatus(initialStatus)
  }, [initialStatus])

  useEffect(() => {
    if (!conversationId) return

    let cancelled = false
    // Tab cache cleared with other queries on logout. The fold translates some events, so a
    // language change replays the log.
    const snapshotKey = [SNAPSHOT_KEY, conversationId, locale()]
    const snapshot = queryClient.getQueryData<JournalSnapshot>(snapshotKey)
    stateRef.current = snapshot?.state ?? emptyChatState()
    pending.current = []
    cursor.current = snapshot?.cursor ?? 0
    setState(stateRef.current)
    setLoading(true)
    setError(null)

    const flush = () => {
      flushTimer.current = null
      if (pending.current.length === 0) return

      let next = stateRef.current
      for (const { seq, ts, event } of pending.current) {
        // Ignore previously applied events (replay after REST reload), ensuring reconnection never
        // duplicates the thread.
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
          // Fold page by page rather than all at the end: the thread stays hidden, but spreading
          // the work yields to the UI between pages, especially useful for long conversations.
          flush()
        })
        if (cancelled) return

        cursor.current = Math.max(cursor.current, read)
        wsClient.setCursor(conversationId, cursor.current)
        // Checkpoint only after fully catching up: a merged-page cursor must never be paired with incomplete state.
        flush()
        queryClient.setQueryData<JournalSnapshot>(snapshotKey, {
          state: stateRef.current,
          cursor: cursor.current,
        })
        const snapshots = queryClient.getQueryCache().findAll({ queryKey: [SNAPSHOT_KEY] })
          .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
        for (const old of snapshots.slice(MAX_SNAPSHOTS)) {
          queryClient.removeQueries({ queryKey: old.queryKey, exact: true })
        }
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Chargement du fil impossible.')
        setLoading(false)
      }
    }

    // Load history before subscribing so the socket resumes exactly where history ends.
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
          // The title belongs to the conversation row, not the log: reread both sidebar and header.
          void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
          void queryClient.invalidateQueries({ queryKey: ['conversations'] })
        },
        onCatchupNeeded: () => void loadFromRest(),
        onConnectionChange: (isConnected) => {
          setConnected(isConnected)
          // Reconnection may have missed events if the socket died unnoticed by the server: replay from the cursor.
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
 * Reconcile pushed status with the log (invariant I2). The log can add activity, never remove it:
 * an open prompt or running turn takes precedence over a delayed status, but an apparently idle log
 * must not override the server. It previously converted every pushed `running` to `idle`: sidebar
 * activity remained visible while the header and composer appeared idle. Server status is
 * persisted, pushed at each transition, snapshotted on subscription, and reset to `interrupted` at
 * daemon startup after abrupt shutdown. There is no reason to contradict it.
 */
function reconcileStatus(pushed: ConversationStatus, state: ChatState): ConversationStatus {
  if (state.items.some(isAwaitingUser)) return 'awaiting_input'
  if (state.turnRunning) return 'running'
  return pushed
}
