import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CardColumn, CardDto, CardLinkDto, CardNoteDto } from '@sillage/protocol'
import { api } from './api'

const cardsKey = (projectId: string) => ['cards', projectId]

/**
 * La liste des projets porte le compte des cartes par colonne, affiché dans la
 * navigation : un changement de colonne, un ajout ou une suppression le rend faux.
 * Une simple retouche de titre ou de description n'y touche pas, et ne relit donc pas
 * la liste, qui interroge git pour chaque projet.
 */
function invalidateCardCounts(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['projects'] })
}

/**
 * `live` : le board est relié à GitHub, des cartes arrivent sans geste de personne ici.
 * Relire toutes les trente secondes suit le rythme des synchronisations.
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

/** Une carte rouverte attend sa sauvegarde en vol avant d'en lancer une autre. */
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
      const now = Date.now()
      queryClient.setQueryData(
        cardsKey(projectId),
        previous.map((card) => {
          const move = moved.get(card.id)
          if (!move) return card
          // L'arrivée dans la colonne aussi, pour l'ordre par arrivée : sans elle, la
          // carte se poserait à son ancienne date avant de sauter au retour du serveur.
          return { ...card, ...move, columnEnteredAt: move.column === card.column ? card.columnEnteredAt : now }
        }),
      )
      return { previous }
    },

    onError: (_error, _columns, context) => {
      // Le serveur a refusé : l'ordre affiché doit redevenir celui qu'il connaît.
      if (context?.previous) queryClient.setQueryData(cardsKey(projectId), context.previous)
    },

    onSettled: () => {
      invalidateCardCounts(queryClient)
      return queryClient.invalidateQueries({ queryKey: cardsKey(projectId) })
    },
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

const notesKey = (cardId: string) => ['card-notes', cardId]

/**
 * Le fil d'une carte, chargé à part du board.
 *
 * Les notes s'accumulent au fil des sessions et ne servent qu'au panneau ouvert : les
 * embarquer dans la liste ferait payer à chaque affichage du board des textes que
 * personne ne regarde.
 */
export function useCardNotes(cardId: string | undefined, live = false) {
  return useQuery({
    queryKey: notesKey(cardId ?? ''),
    queryFn: () => api.get<CardNoteDto[]>(`/api/cards/${cardId}/notes`),
    enabled: Boolean(cardId),
    staleTime: 15_000,
    // Une note en route vers GitHub part dans les secondes qui suivent : on la suit de
    // près. Une carte suivie reçoit aussi les commentaires écrits là-bas.
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
      // Le compte affiché sur la tuile vient du board, qui ne sait rien de cet ajout.
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
