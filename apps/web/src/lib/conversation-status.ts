import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConversationDto, ConversationMetrics, ConversationStatus } from '@sillage/protocol'
import { wsClient } from './ws-client'

/**
 * Socket-pushed statuses outside the REST cache. The conversation list is a snapshot taken at load
 * and cannot reflect later transitions, so sidebar running dots used to remain frozen until
 * refresh. These statuses overlay rather than replace the snapshot: the socket only pushes changes
 * and has no initial value.
 */

const statuses = new Map<string, ConversationStatus>()
// Observed completions remain available when switching sidebar projects.
const settledAt = new Map<string, number>()
export function liveSettledAt(conversationId: string): number {
  return settledAt.get(conversationId) ?? 0
}
/**
 * Background tasks per conversation in a separate table. Do not merge them into an object:
 * `useSyncExternalStore` compares snapshot identity, and rebuilding an object on every read would
 * cause endless rendering. Two tables of primitive values avoid memoization.
 */
const backgrounds = new Map<string, number>()
/** Armed loops per conversation. Separate table for the same reason. */
const loops = new Map<string, number>()
/** Latest known `seq` per conversation for unread state. Separate table for the same reason. */
const seqs = new Map<string, number>()
/**
 * Volume readings per conversation for detailed sidebar mode. The only table holding objects:
 * `useSyncExternalStore` identity comparison prohibits recreating them on read. Store the received
 * object unchanged and replace it only when a field changes.
 */
const metrics = new Map<string, ConversationMetrics>()
const listeners = new Set<() => void>()

/**
 * Exported for views aggregating conversations: they cannot subscribe per row and build their own
 * snapshot from `liveSeq`.
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

/** Live status, or undefined until one is pushed for this thread. */
export function useLiveStatus(conversationId: string): ConversationStatus | undefined {
  return useSyncExternalStore(
    subscribeStatus,
    () => statuses.get(conversationId),
    () => undefined,
  )
}

/**
 * Running background task count, 0 before any push. Always 0 for a cold conversation: these tasks
 * live in the CLI process.
 */
export function useLiveBackground(conversationId: string): number {
  return useSyncExternalStore(
    subscribeStatus,
    () => backgrounds.get(conversationId) ?? 0,
    () => 0,
  )
}

/**
 * Armed loop count, 0 before any push. Always 0 for a cold conversation: scheduled tasks fire only
 * while the CLI runs.
 */
export function useLiveLoops(conversationId: string): number {
  return useSyncExternalStore(
    subscribeStatus,
    () => loops.get(conversationId) ?? 0,
    () => 0,
  )
}

/**
 * Latest notable `seq` pushed for this thread, 0 before receiving anything. Zero means no update,
 * not an empty log: callers compare it with REST `lastNotableSeq` and keep the larger value.
 */
export function useLiveSeq(conversationId: string): number {
  return useSyncExternalStore(
    subscribeStatus,
    () => seqs.get(conversationId) ?? 0,
    () => 0,
  )
}

/**
 * Latest pushed readings, `undefined` until any arrive for this thread. Callers then retain REST
 * list values: the socket pushes changes only, with no initial value.
 */
export function useLiveMetrics(conversationId: string): ConversationMetrics | undefined {
  return useSyncExternalStore(
    subscribeStatus,
    () => metrics.get(conversationId),
    () => undefined,
  )
}

/** Direct read for snapshots composed by `subscribeStatus` subscribers. */
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
 * Window for batching list signals. A single gesture can produce several: dragging rewrites order
 * and the originating tab already rereads. One refetch suffices for the burst.
 */
const LISTS_REFRESH_DELAY_MS = 150

/** Minimum indicator duration: briefer activity would flash too quickly to read. */
const MIN_REFRESH_MS = 500

/**
 * Connect the browser tab to the status stream. Mounted by the sidebar, the only view displaying
 * conversations it has not opened.
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
        // A session created elsewhere must enter the overview without reload. Its first status is
        // enough; later tokens do not trigger another query.
        if (!statuses.has(conversationId)) {
          const known = queryClient.getQueryData<ConversationDto[]>(['conversations', 'all'])
          if (known && !known.some((entry) => entry.id === conversationId)) {
            void queryClient.invalidateQueries({ queryKey: ['conversations'] })
            // An unknown thread may be a scheduled run that just started.
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
        if (wasBusy && !busy) {
          settledAt.set(conversationId, Date.now())
          // A completed turn may have committed or written in a worktree: reread worktrees.
          void queryClient.invalidateQueries({ queryKey: ['worktree-status'] })
        }
        if (busy) settledAt.delete(conversationId)
        statuses.set(conversationId, status)
        backgrounds.set(conversationId, background)
        loops.set(conversationId, loopCount)
        seqs.set(conversationId, lastNotableSeq)
        // Only when content changed: storing the object on every push would rerender detailed rows
        // even for identical readings.
        if (metricsChanged) metrics.set(conversationId, pushed)
        emit()
      },
      onResync: () => {
        // Pre-disconnect pushes are no longer authoritative: the refreshed list takes over and
        // subsequent pushes build from it.
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
          void queryClient.invalidateQueries({ queryKey: ['actions'] })
          void queryClient.invalidateQueries({ queryKey: ['worktree-status'] })
          // The open thread's header must also reflect renames or deletion elsewhere without requiring navigation away.
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
 * Reread stale data without clearing anything when users are about to view the list without an
 * explicit signal: opening the phone drawer, which stays mounted offscreen and never refreshes
 * itself.
 */
export function useRevalidateLists(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    wsClient.check()
    void queryClient.refetchQueries({ queryKey: ['conversations'], type: 'active', stale: true })
  }, [queryClient])
}

/**
 * Manual refresh from the sidebar button or gesture. Trust no displayed data: replace the socket,
 * clearing pushed statuses and resubscribing the open thread from its cursor, then reread lists.
 * Follow the reconnect path without waiting to detect a disconnect.
 */
export function useRefreshLists(): { refreshing: boolean; refresh: () => void } {
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  // Use a ref rather than state: two gestures within one render would both see `false`.
  const running = useRef(false)

  const refresh = useCallback(() => {
    if (running.current) return
    running.current = true
    setRefreshing(true)

    const work = async () => {
      await wsClient.resync()
      // `cancelRefetch: false`: reconnection just restarted the list query; join that read instead
      // of interrupting it with an identical one.
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
