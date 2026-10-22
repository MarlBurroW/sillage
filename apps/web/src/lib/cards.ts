import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CardColumn, CardDto, CardLinkDto, CardNoteDto, CardRelationDto, CardRelationKind } from '@sillage/protocol'
import { api } from './api'

const cardsKey = (projectId: string) => ['cards', projectId]

/**
 * The project list holds card counts by column for navigation: moving, adding, or deleting a card
 * invalidates them. Editing only title or description does not, so avoid rereading the list, which
 * probes Git for every project.
 */
function invalidateCardCounts(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['projects'] })
}

/**
 * `live` means the board is linked to GitHub and cards can arrive without local actions. Polling
 * every thirty seconds matches synchronization cadence.
 */
export function useCards(projectId: string | undefined, live = false) {
  return useQuery({
    queryKey: cardsKey(projectId ?? ''),
    queryFn: () => api.get<CardDto[]>(`/api/projects/${projectId}/cards`),
    enabled: Boolean(projectId),
    staleTime: 15_000,
    refetchInterval: live ? 30_000 : false,
  })
}

export function useCreateCard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { title: string; description?: string; column?: CardColumn; github?: boolean }) =>
      api.post<CardDto>(`/api/projects/${projectId}/cards`, input),
    onSuccess: () => {
      invalidateCardCounts(queryClient)
      return queryClient.invalidateQueries({ queryKey: cardsKey(projectId) })
    },
  })
}

export function useUpdateCard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: ['update-card', projectId],
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string
      title?: string
      description?: string
      column?: CardColumn
    }) => api.patch<CardDto>(`/api/cards/${id}`, patch),
    onSuccess: (_card, patch) => {
      if (patch.column) invalidateCardCounts(queryClient)
      return queryClient.invalidateQueries({ queryKey: cardsKey(projectId) })
    },
  })
}

/** A reopened card waits for its in-flight save before starting another. */
export function useCardSaving(cardId: string) {
  return useIsMutating({
    mutationKey: ['update-card'],
    predicate: (mutation) => (mutation.state.variables as { id?: string } | undefined)?.id === cardId,
  }) > 0
}

export function useDeleteCard(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/cards/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cardsKey(projectId) })
      invalidateCardCounts(queryClient)
      // Linked conversations lose their badge, invalidating their list.
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })
}

/** A board column in the order to be persisted. */
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

      // Show the move immediately: waiting for a reply would snap the card back during the round
      // trip, looking like rejection.
      const moved = new Map<string, { column: CardColumn; position: number }>()
      for (const group of columns) {
        group.ids.forEach((id, index) => moved.set(id, { column: group.column, position: index }))
      }
      const now = Date.now()
      queryClient.setQueryData(
        cardsKey(projectId),
        previous.map((card) => {
          const move = moved.get(card.id)
          if (!move) return card
          // Update arrival time too for arrival-based order; otherwise the card would sit at its
          // former date before jumping on reply.
          return { ...card, ...move, columnEnteredAt: move.column === card.column ? card.columnEnteredAt : now }
        }),
      )
      return { previous }
    },

    onError: (_error, _columns, context) => {
      // Server rejection: restore the server-known order.
      if (context?.previous) queryClient.setQueryData(cardsKey(projectId), context.previous)
    },

    onSettled: () => {
      invalidateCardCounts(queryClient)
      return queryClient.invalidateQueries({ queryKey: cardsKey(projectId) })
    },
  })
}

/**
 * Cards available after `#`, without the board's sessions or backlinks. Use `query !== null` rather
 * than nonempty length: a bare `#` must open the list like file `@` mentions.
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

const notesKey = (cardId: string) => ['card-notes', cardId]

/**
 * Card thread loaded separately from the board. Notes accumulate across sessions and serve only the
 * open panel: bundling them into the list would load unread text on every board display.
 */
export function useCardNotes(cardId: string | undefined, live = false) {
  return useQuery({
    queryKey: notesKey(cardId ?? ''),
    queryFn: () => api.get<CardNoteDto[]>(`/api/cards/${cardId}/notes`),
    enabled: Boolean(cardId),
    staleTime: 15_000,
    // A note awaiting GitHub delivery should leave within seconds: poll closely. Tracked cards also
    // receive comments written there.
    refetchInterval: (query) =>
      query.state.data?.some((note) => note.publication === 'pending') ? 3_000 : live ? 30_000 : false,
  })
}

export function useAddCardNote(projectId: string, cardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: ['add-card-note', cardId],
    mutationFn: ({ body, publish = false }: { body: string; publish?: boolean }) =>
      api.post<CardNoteDto[]>(`/api/cards/${cardId}/notes`, { body, publish }),
    onSuccess: (notes) => {
      queryClient.setQueryData(notesKey(cardId), notes)
      // The tile count comes from the board, which does not know about this addition.
      void queryClient.invalidateQueries({ queryKey: cardsKey(projectId) })
    },
  })
}

export function useCardNoteSaving(cardId: string) {
  return useIsMutating({ mutationKey: ['add-card-note', cardId] }) > 0
}

export function useDeleteCardNote(projectId: string, cardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (noteId: string) => api.delete<void>(`/api/card-notes/${noteId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notesKey(cardId) })
      void queryClient.invalidateQueries({ queryKey: cardsKey(projectId) })
    },
  })
}

const relationsKey = (cardId: string) => ['card-relations', cardId]

export function useCardRelations(cardId: string) {
  return useQuery({
    queryKey: relationsKey(cardId),
    queryFn: () => api.get<CardRelationDto[]>(`/api/cards/${cardId}/relations`),
    // Agents may add a link while the ticket is open.
    refetchInterval: 15_000,
  })
}

export function useChangeCardRelation(cardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ remove, ...body }: { target: number; kind: CardRelationKind; remove?: boolean }) => {
      if (remove) await api.delete<void>(`/api/cards/${cardId}/relations`, body)
      else await api.post<CardRelationDto[]>(`/api/cards/${cardId}/relations`, body)
    },
    // Both directions are visible: invalidate the other ticket's cache too.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['card-relations'] }),
  })
}
