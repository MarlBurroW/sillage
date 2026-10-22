import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ConversationDto } from '@sillage/protocol'
import { api } from './api'
import { liveSeq, subscribeStatus } from './conversation-status'

/**
 * Something happened in this thread since the account's last visit. Take the maximum of the REST
 * and socket sequences: the former dates from list loading, the latter covers only subsequent
 * pushes. Neither is complete alone.
 */
export function isUnread(conversation: ConversationDto, pushedSeq: number): boolean {
  return Math.max(conversation.lastNotableSeq, pushedSeq) > conversation.lastReadSeq
}

/**
 * Whether any of these conversations has updates. Use a boolean snapshot instead of per-row
 * subscriptions: collapsed projects render no rows to subscribe for them. A primitive value makes
 * `useSyncExternalStore` render only when it changes.
 */
export function useHasUnread(
  conversations: ConversationDto[],
  /** The open thread does not count because the user is already reading it. */
  openConversationId?: string,
): boolean {
  const snapshot = () =>
    conversations.some(
      (entry) => entry.id !== openConversationId && isUnread(entry, liveSeq(entry.id)),
    )
  return useSyncExternalStore(subscribeStatus, snapshot, snapshot)
}

/**
 * A running turn pushes a `seq` every few dozen milliseconds. Send read cursors at fixed intervals
 * rather than on each change, avoiding one round trip per token in long conversations.
 */
const MARK_INTERVAL_MS = 2000

/**
 * Write the cache rather than invalidate: only a server-confirmed integer changed, and rereading
 * the whole list would flash the sidebar every turn. The partial key matches both global and
 * per-project lists holding the same objects.
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
 * Maintain the open thread's read cursor. Deliberately send nothing extra when leaving mid-turn:
 * content arriving afterward occurred while looking elsewhere and must become unread. The last send
 * is at most `MARK_INTERVAL_MS` old, bounding rediscovered content to the few seconds before
 * leaving.
 */
export function useTrackRead(conversationId: string | undefined, lastSeq: number): void {
  const queryClient = useQueryClient()

  // Keep `seq` in a ref: the interval mounts once per conversation and must read the current value,
  // not the captured initial one.
  const seqRef = useRef(lastSeq)
  seqRef.current = lastSeq

  // Keep the sender in a ref too, so the progress effect invokes the current conversation's sender
  // without remounting on every `seq`.
  const sendRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!conversationId) return

    let confirmed = 0
    let inFlight = false
    let attemptedAt = 0

    const send = async () => {
      // Background tabs keep ticking. Without this check, leaving Sillage open while an agent works
      // would mark the conversation read continuously, precisely the situation unread tracking must
      // cover.
      if (document.visibilityState !== 'visible') return

      const seq = seqRef.current
      if (inFlight || seq <= confirmed) return
      // Send immediately first, then space subsequent sends: running turns push a `seq` every few
      // dozen milliseconds.
      if (attemptedAt > 0 && Date.now() - attemptedAt < MARK_INTERVAL_MS) return

      inFlight = true
      attemptedAt = Date.now()
      try {
        const result = await api.post<{ lastReadSeq: number }>(
          `/api/conversations/${conversationId}/read`,
          { seq },
        )
        // Advance on response rather than send: retry a lost POST on the next tick or the
        // conversation would stay unread for the whole visit.
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

  // Opening a thread must clear unread immediately rather than on the next tick: long histories
  // require several pages, and an extra two seconds after the last page left the row bold for no
  // visible reason.
  useEffect(() => {
    sendRef.current()
  }, [lastSeq])
}
