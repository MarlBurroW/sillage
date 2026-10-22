import { useEffect, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BASELINE_DECISION_SOURCES, decisionSourceKindSchema, type DecisionDto } from '@sillage/protocol'
import { api } from './api'
import { wsClient } from './ws-client'

const decisionsKey = (status: 'pending' | 'all') => ['decisions', status]

/**
 * Sources this client can display: the server sends newer ones only to clients explicitly naming
 * them (see `requestedDecisionSources`).
 */
const SOURCES = `sources=${decisionSourceKindSchema.options.join(',')}`
// The queue and counter remain agent-only even against an older server.
const INBOX_SOURCES = `sources=${BASELINE_DECISION_SOURCES.join(',')}`

/**
 * Account decisions. Refetch on server change signals and every minute as fallback: deadlines pass
 * without user actions.
 */
export function useDecisions(status: 'pending' | 'all' = 'pending') {
  return useQuery({
    queryKey: decisionsKey(status),
    queryFn: async () => (await api.get<{ decisions: DecisionDto[] }>(`/api/decisions?status=${status}&${INBOX_SOURCES}`)).decisions,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
}

export function useDecision(id: string | null) {
  return useQuery({
    queryKey: ['decision', id],
    queryFn: () => api.get<DecisionDto>(`/api/decisions/${id}?${SOURCES}`),
    enabled: Boolean(id),
  })
}

export function useAnswerDecision() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, option, text }: { id: string; option: string | null; text: string }) =>
      api.post<DecisionDto>(`/api/decisions/${id}/answer`, { option, text }),
    onSuccess: (decision) => {
      queryClient.setQueryData(['decision', decision.id], decision)
      return queryClient.invalidateQueries({ queryKey: ['decisions'] })
    },
  })
}

/** Follow server-pushed changes and set the installed app badge to the pending decision count. */
export function useDecisionsLive(): void {
  const queryClient = useQueryClient()
  const { data } = useDecisions('pending')
  useEffect(
    () =>
      wsClient.onDecisionsChanged(() => {
        void queryClient.invalidateQueries({ queryKey: ['decisions'] })
        void queryClient.invalidateQueries({ queryKey: ['decision'] })
      }),
    [queryClient],
  )
  const count = data?.length ?? 0
  useEffect(() => {
    const badge = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
    if (count > 0) void badge.setAppBadge?.(count).catch(() => {})
    else void badge.clearAppBadge?.().catch(() => {})
  }, [count])
}

// --- Open decision shared outside React --------------------------------------

let openId: string | null = null
const listeners = new Set<() => void>()

/** Open a decision dialog from anywhere: sidebar, toast, or history. */
export function openDecision(id: string | null): void {
  openId = id
  for (const listener of listeners) listener()
}

export function useOpenDecision(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => openId,
    () => openId,
  )
}
