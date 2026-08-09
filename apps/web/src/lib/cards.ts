import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CardColumn, CardDto, CardLinkDto } from '@sillage/protocol'
import { api } from './api'

const cardsKey = (projectId: string) => ['cards', projectId]

export function useCards(projectId: string | undefined) {
  return useQuery({
    queryKey: cardsKey(projectId ?? ''),
    queryFn: () => api.get<CardDto[]>(`/api/projects/${projectId}/cards`),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  })
}

export function useCreateCard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { title: string; description?: string; column?: CardColumn }) =>
      api.post<CardDto>(`/api/projects/${projectId}/cards`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cardsKey(projectId) }),
  })
}

export function useUpdateCard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string
      title?: string
      description?: string
      column?: CardColumn
    }) => api.patch<CardDto>(`/api/cards/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cardsKey(projectId) }),
  })
}

export function useDeleteCard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/cards/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cardsKey(projectId) })
      // Les conversations rattachées perdent leur puce : leur liste devient fausse.
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })
}

/** Une colonne du board dans son ordre, telle qu'elle sera écrite. */
export interface CardColumnOrder {
  column: CardColumn
  ids: string[]
}

export function useReorderCards(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (columns: CardColumnOrder[]) =>
      api.post<{ ok: true }>(`/api/projects/${projectId}/cards/order`, { columns }),

    onMutate: async (columns) => {
      await queryClient.cancelQueries({ queryKey: cardsKey(projectId) })
      const previous = queryClient.getQueryData<CardDto[]>(cardsKey(projectId))
      if (!previous) return { previous }

      // Le déplacement doit se voir immédiatement : attendre la réponse ferait revenir
      // la carte à sa place le temps d'un aller-retour, ce qui se lit comme un refus.
      const moved = new Map<string, { column: CardColumn; position: number }>()
      for (const group of columns) {
        group.ids.forEach((id, index) => moved.set(id, { column: group.column, position: index }))
      }
      queryClient.setQueryData(
        cardsKey(projectId),
        previous.map((card) => {
          const move = moved.get(card.id)
          return move ? { ...card, ...move } : card
        }),
      )
      return { previous }
    },

    onError: (_error, _columns, context) => {
      // Le serveur a refusé : l'ordre affiché doit redevenir celui qu'il connaît.
      if (context?.previous) queryClient.setQueryData(cardsKey(projectId), context.previous)
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey: cardsKey(projectId) }),
  })
}

/**
 * Cartes citables après un `#`, sans les sessions ni les backlinks que porte le board.
 *
 * `query !== null` plutôt que `query.length > 0` : un `#` seul doit ouvrir la liste,
 * comme le `@` des fichiers.
 */
export function useCardSuggestions(projectId: string | undefined, query: string | null) {
  return useQuery({
    queryKey: ['card-mentions', projectId, query],
    queryFn: async () => {
      const params = new URLSearchParams({ q: query ?? '' })
      const result = await api.get<{ cards: CardLinkDto[] }>(
        `/api/projects/${projectId}/cards/mentions?${params}`,
      )
      return result.cards
    },
    enabled: Boolean(projectId) && query !== null,
    staleTime: 15_000,
  })
}
