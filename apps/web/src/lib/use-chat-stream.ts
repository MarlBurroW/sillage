import { recordPerformance } from './performance-diagnostics'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentConfig, ConversationStatus, SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState, isAwaitingUser, type ChatState } from './chat-fold'
import { fetchJournal, type JournalPage } from './conversations'
import { wsClient } from './ws-client'
import { translate } from './i18n'
import { ApiRequestError } from './api'
import { fetchThreadPage, mergeThreadPage } from './thread-pages'
import { retainedBytes, JOURNAL_CACHE_BYTES, JOURNAL_CACHE_IDLE_MS } from './cache-budget'

interface JournalSnapshot {
  state: ChatState
  cursor: number
  before: number
  hasMore: boolean
  bytes: number
}

const SNAPSHOT_KEY = 'chat-journal-snapshot-v1'

/** Batch deltas: rendering once per token destroys mobile frame rates. */
const FLUSH_INTERVAL_MS = 60

/** The fold edits its input object and loop counters; cached cursors must keep their matching state. */
function snapshotState(state: ChatState): ChatState {
  return { ...state, loopFires: new Map(state.loopFires) }
}

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
   * The initial view is not ready for placement. Older history has a separate loading state;
   * a prepared projection can reveal recent turns without folding the whole journal.
   */
  loading: boolean
  error: string | null
  hasMore: boolean
  loadingOlder: boolean
  loadOlder: () => Promise<void>
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
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const older = useRef<() => Promise<void>>(async () => {})
  const loadOlder = useCallback(() => older.current(), [])
  const queryClient = useQueryClient()

  useEffect(() => {
    setStatus(initialStatus)
  }, [initialStatus])

  useEffect(() => {
    if (!conversationId) return
    const id = conversationId

    const controller = new AbortController()
    const { signal } = controller
    // The projection is language-neutral; logout clears this tab-local cache.
    const snapshotKey = [SNAPSHOT_KEY, conversationId]
    queryClient.setQueryDefaults([SNAPSHOT_KEY], { gcTime: JOURNAL_CACHE_IDLE_MS })
    const snapshot = queryClient.getQueryData<JournalSnapshot>(snapshotKey)
    // Keep replay state local to this subscription: a late callback from the old
    // conversation must never edit the new conversation's cursor or pending events.
    let currentState = snapshot ? snapshotState(snapshot.state) : emptyChatState()
    let pending: JournalPage = []
    let flushTimer: number | null = null
    let replay: Promise<void> | null = null
    let subscription: { active: boolean; stop: () => void } | null = null
    // Coalesced deltas retain their first seq. The examined cursor can be further
    // ahead than state.lastSeq, and must also exclude those fragments from live replay.
    let cursor = snapshot?.cursor ?? 0
    let before = snapshot?.before ?? Number.MAX_SAFE_INTEGER
    let more = snapshot?.hasMore ?? false
    let initialized = !!snapshot
    setHasMore(more)
    setLoadingOlder(false)
    recordPerformance('thread-open', { cached: Number(!!snapshot) })
    setState(currentState)
    setLoading(true)
    setError(null)
    setConnected(false)
    setWarm(null)
    setAppliedConfig(null)

    const apply = (entries: JournalPage, readThrough: number) => {
      if (signal.aborted) return
      for (const { seq, ts, event } of entries) {
        if (seq <= cursor) continue
        currentState = applyEvent(currentState, seq, ts, event)
        cursor = seq
      }
      cursor = Math.max(cursor, readThrough)
      setState(currentState)
    }

    const flush = () => {
      if (flushTimer !== null) clearTimeout(flushTimer)
      flushTimer = null
      if (pending.length === 0) return
      apply(pending, cursor)
      pending = []
    }

    const stopSubscription = () => {
      if (!subscription) return
      subscription.active = false
      subscription.stop()
      subscription = null
    }

    const loadFromRest = (history: boolean | 'refresh' = false): Promise<void> => {
      if (signal.aborted) return Promise.resolve()
      if (replay) return replay

      // Live events with larger seqs would hide missing historical entries behind
      // the idempotence guard. Stop this subscription during REST; the journal keeps
      // new events and the next subscription replays them after the completed cursor.
      stopSubscription()
      flush()
      const started = performance.now()
      replay = (async () => {
        try {
          if (history || !initialized) {
            try {
              const page = await fetchThreadPage(id, signal, history === 'refresh' ? 0 : history ? before : undefined, history ? cursor : undefined)
              if (signal.aborted) return
              currentState = history && !page.reset ? mergeThreadPage(currentState, page.state) : page.state
              cursor = page.cursor
              if (history !== 'refresh' || page.reset) {
                before = page.before
                more = page.hasMore
              }
              setHasMore(more)
              setState(currentState)
              initialized = true
            } catch (err) {
              if (signal.aborted || history || (err instanceof ApiRequestError && ![404, 503].includes(err.status))) throw err
              // Older servers and unavailable disposable projections retain the journal path.
              await fetchJournal(conversationId, cursor, apply, signal)
              initialized = true
            }
          } else {
            await fetchJournal(conversationId, cursor, apply, signal)
          }
          if (signal.aborted) return

          // Active reading state is independent of this evictable return-to-thread cache.
          const bytes = retainedBytes(currentState, JOURNAL_CACHE_BYTES)
          if (bytes <= JOURNAL_CACHE_BYTES) queryClient.setQueryData<JournalSnapshot>(snapshotKey, {
            state: snapshotState(currentState), cursor, before, hasMore: more, bytes,
          })
          else queryClient.removeQueries({ queryKey: snapshotKey, exact: true })
          const snapshots = queryClient.getQueryCache().findAll({ queryKey: [SNAPSHOT_KEY] })
            .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
          let retained = 0
          for (const old of snapshots) {
            retained += (old.state.data as JournalSnapshot).bytes
            if (retained > JOURNAL_CACHE_BYTES) queryClient.removeQueries({ queryKey: old.queryKey, exact: true })
          }
          recordPerformance(history ? 'thread-history' : 'thread-ready', { ms: performance.now() - started, items: currentState.items.length, cursor, bytes, cacheBytes: Math.min(retained, JOURNAL_CACHE_BYTES), cacheEntries: queryClient.getQueryCache().findAll({ queryKey: [SNAPSHOT_KEY] }).length })
          setError(null)
          setLoading(false)
        } catch (err) {
          if (signal.aborted) return
          recordPerformance('thread-error', { ms: performance.now() - started })
          setError(err instanceof Error ? err.message : translate('journal.content.error'))
          setLoading(false)
        } finally {
          replay = null
          if (!signal.aborted) setLoadingOlder(false)
          if (!signal.aborted) subscribeLive()
        }
      })()
      return replay
    }

    function subscribeLive() {
      const live = { active: true, stop: () => {} }
      subscription = live
      let hasConnected = false
      wsClient.setCursor(id, cursor)
      live.stop = wsClient.subscribe(id, cursor, {
        onEvent: (seq: number, ts: number, event: SillageEvent) => {
          if (!live.active || signal.aborted || seq <= cursor) return
          const received = pending.at(-1)?.seq ?? cursor
          if (seq <= received) return
          // A jump can be compacted history or a late frame from the previous
          // subscription. REST resolves either case before newer state hides the gap.
          if (seq > received + 1) {
            older.current = () => {
      if (!more || signal.aborted) return Promise.resolve()
      setLoadingOlder(true)
      return loadFromRest(true)
    }
    void loadFromRest()
            return
          }
          // An omitted old message can receive more blocks under the same native ID. Resolve its
          // persisted row before folding: inventing a new row here would duplicate it on paging.
          if (more && ((event.type === 'message.completed' || event.type === 'message.delta' || event.type === 'thinking.delta')
            ? !currentState.items.some((item) => item.kind === 'message' && item.id === event.messageId)
            : event.type === 'agent.notice' && event.id && !currentState.items.some((item) => item.kind === 'notice' && item.id === event.id))) {
            void loadFromRest('refresh')
            return
          }
          pending.push({ seq, ts, event })
          if (event.type === 'agent.notice' && event.code === 'antigravity_account_signed_out') {
            void queryClient.invalidateQueries({ queryKey: ['antigravity-accounts'] })
            void queryClient.invalidateQueries({ queryKey: ['agents', 'antigravity'] })
            void queryClient.invalidateQueries({ queryKey: ['usage', 'antigravity'] })
          }
          if (flushTimer === null) flushTimer = window.setTimeout(flush, FLUSH_INTERVAL_MS)
        },
        onStatus: (next, isWarm, applied) => {
          if (!live.active || signal.aborted) return
          setStatus(next)
          setWarm(isWarm)
          setAppliedConfig(applied)
        },
        onTitle: () => {
          if (!live.active || signal.aborted) return
          // The title belongs to the conversation row, not the log: reread both sidebar and header.
          void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
          void queryClient.invalidateQueries({ queryKey: ['conversations'] })
        },
        onCatchupNeeded: () => {
          if (live.active) void loadFromRest()
        },
        onConnectionChange: (isConnected) => {
          if (!live.active || signal.aborted) return
          setConnected(isConnected)
          // The first subscription already follows REST; reconnects need a new catch-up.
          if (isConnected && hasConnected) void loadFromRest()
          if (isConnected) hasConnected = true
        },
      })
    }

    older.current = () => {
      if (!more || signal.aborted) return Promise.resolve()
      setLoadingOlder(true)
      return loadFromRest(true)
    }
    void loadFromRest()
    return () => {
      controller.abort()
      stopSubscription()
      if (flushTimer !== null) clearTimeout(flushTimer)
      pending = []
    }
  }, [conversationId, queryClient])

  return {
    state,
    status: reconcileStatus(status, state),
    connected,
    warm,
    appliedConfig,
    loading,
    error, hasMore, loadingOlder, loadOlder,
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
