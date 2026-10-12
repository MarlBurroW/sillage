import { useEffect, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DecisionDto } from '@sillage/protocol'
import { api } from './api'
import { wsClient } from './ws-client'

const decisionsKey = (status: 'pending' | 'all') => ['decisions', status]

/**
 * Les décisions du compte. Relues quand le serveur signale un changement, et toutes les
 * minutes en repli : une échéance passe sans que personne n'ait rien fait.
 */
export function useDecisions(status: 'pending' | 'all' = 'pending') {
  return useQuery({
    queryKey: decisionsKey(status),
    queryFn: async () => (await api.get<{ decisions: DecisionDto[] }>(`/api/decisions?status=${status}`)).decisions,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
}

export function useDecision(id: string | null) {
  return useQuery({
    queryKey: ['decision', id],
    queryFn: () => api.get<DecisionDto>(`/api/decisions/${id}`),
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

/**
 * Suit les changements poussés par le serveur, et tient la pastille de l'icône de
 * l'application installée au nombre de décisions en attente.
 */
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

// --- La décision ouverte, partagée hors de React --------------------------------------

let openId: string | null = null
const listeners = new Set<() => void>()

/** Ouvre le dialogue d'une décision, d'où qu'on le demande : sidebar, toast, historique. */
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
