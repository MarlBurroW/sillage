import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentConfig,
  ElicitationAction,
  ElicitationValue,
  ConversationDto,
  JournalPageDto,
  SillageEvent,
} from '@sillage/protocol'
import { api } from './api'
import { uuidv4 } from './uuid'

export const conversationsKey = (projectId: string) => ['conversations', projectId]
const ALL_CONVERSATIONS_KEY = ['conversations', 'all']

/** Toutes les conversations visibles, pour la sidebar. Une requête, pas une par projet. */
export function useAllConversations() {
  return useQuery({
    queryKey: ALL_CONVERSATIONS_KEY,
    queryFn: () => api.get<ConversationDto[]>('/api/conversations'),
    staleTime: 10_000,
  })
}

/**
 * Ordre manuel au sein d'un projet.
 *
 * Le réordonnancement est appliqué localement avant la réponse du serveur : un
 * glisser-déposer qui attend un aller-retour réseau se voit, et se voit mal.
 */
export function useReorderConversations(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ ok: true }>(`/api/projects/${projectId}/conversations/order`, { ids }),

    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ALL_CONVERSATIONS_KEY })
      const previous = queryClient.getQueryData<ConversationDto[]>(ALL_CONVERSATIONS_KEY)
      if (!previous) return { previous }

      // Les conversations des autres projets ne bougent pas : on remet celles du
      // projet concerné dans les emplacements qu'elles occupaient déjà.
      const byId = new Map(previous.map((entry) => [entry.id, entry]))
      const reordered = ids.map((id) => byId.get(id)).filter((entry) => entry !== undefined)
      const slots = previous.flatMap((entry, index) => (entry.projectId === projectId ? [index] : []))

      const next = [...previous]
      slots.forEach((slot, index) => {
        const entry = reordered[index]
        if (entry) next[slot] = entry
      })
      queryClient.setQueryData(ALL_CONVERSATIONS_KEY, next)

      return { previous }
    },

    onError: (_error, _ids, context) => {
      // Le serveur a refusé : l'ordre affiché doit redevenir celui qu'il connaît.
      if (context?.previous) queryClient.setQueryData(ALL_CONVERSATIONS_KEY, context.previous)
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  })
}

export function useRenameConversation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<{ ok: true }>(`/api/conversations/${id}`, { title }),
    onSuccess: (_result, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['conversation', id] })
    },
  })
}

export function useArchiveConversation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.patch<{ ok: true }>(`/api/conversations/${id}`, { archived }),
    onSuccess: (_result, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['conversation', id] })
    },
  })
}

export function useConversations(projectId: string | undefined) {
  return useQuery({
    queryKey: conversationsKey(projectId ?? ''),
    queryFn: () => api.get<ConversationDto[]>(`/api/projects/${projectId}/conversations`),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  })
}

export function useConversation(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.get<ConversationDto>(`/api/conversations/${conversationId}`),
    enabled: Boolean(conversationId),
  })
}

export function useCreateConversation(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      agent: AgentConfig['agent']
      config: AgentConfig
      title?: string
      /** null signifie « dossier du projet », sans worktree. */
      worktreeId?: string | null
      /** Envoyé avec la création : sans message, aucune conversation n'est écrite. */
      firstMessage?: {
        clientMessageId: string
        text: string
        attachmentIds: string[]
        mentions: string[]
        skills: string[]
      }
    }) =>
      api.post<ConversationDto>(`/api/projects/${projectId}/conversations`, {
        worktreeId: null,
        ...input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function useDeleteConversation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/conversations/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function sendMessage(
  conversationId: string,
  text: string,
  attachmentIds: string[] = [],
  mentions: string[] = [],
  skills: string[] = [],
): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/messages`, {
    // Identifiant stable côté client : un renvoi après timeout réseau est ignoré
    // par le serveur au lieu de poster le message deux fois (invariant I5).
    clientMessageId: uuidv4(),
    text,
    attachmentIds,
    mentions,
    skills,
  })
}

/**
 * Infléchit le tour en cours au lieu d'ouvrir le suivant.
 *
 * N'existe que là où le CLI le permet : le serveur refuse explicitement si aucun tour
 * n'est en cours, plutôt que de replier sur la file d'attente.
 */
export function steerConversation(
  conversationId: string,
  text: string,
  attachmentIds: string[] = [],
  mentions: string[] = [],
  skills: string[] = [],
): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/steer`, {
    clientMessageId: uuidv4(),
    text,
    attachmentIds,
    mentions,
    skills,
  })
}

/** Demande à l'agent de résumer la conversation pour libérer du contexte. */
export function compactConversation(conversationId: string): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/compact`)
}

export function interruptConversation(conversationId: string): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/interrupt`)
}

export function stopBackgroundTask(conversationId: string, taskId: string): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/background/${encodeURIComponent(taskId)}/stop`)
}

export function decidePermission(
  conversationId: string,
  requestId: string,
  decision: 'allowed' | 'denied',
  scope: 'once' | 'session' | 'always',
): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/permissions/${requestId}`, {
    decision,
    scope,
  })
}

export function answerQuestion(
  conversationId: string,
  requestId: string,
  status: 'answered' | 'cancelled',
  answers: Record<string, string[]>,
): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/questions/${requestId}`, {
    status,
    answers,
  })
}

/**
 * Branche la conversation à un point du fil.
 *
 * `throughSeq` est le dernier événement conservé : la branche reprend l'historique
 * jusque-là, et l'agent y est ramené au même point.
 */
export function forkConversation(
  conversationId: string,
  throughSeq: number,
): Promise<ConversationDto> {
  return api.post<ConversationDto>(`/api/conversations/${conversationId}/fork`, { throughSeq })
}

/** Retire un message de la file avant son envoi au CLI. */
export function cancelQueuedMessage(conversationId: string, queueId: string): Promise<unknown> {
  return api.delete(`/api/conversations/${conversationId}/queue/${queueId}`)
}

/** Fait passer un message en attente dans le tour en cours au lieu du suivant. */
export function steerQueuedMessage(conversationId: string, queueId: string): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/queue/${queueId}/steer`)
}

export function answerElicitation(
  conversationId: string,
  requestId: string,
  action: ElicitationAction,
  content: Record<string, ElicitationValue>,
): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/elicitations/${requestId}`, {
    action,
    content,
  })
}

export function decidePlan(
  conversationId: string,
  requestId: string,
  decision: 'approved' | 'rejected',
  /** L'`id` d'une option de suite annoncée par le plan, opaque pour le client. */
  followUpMode: string | null,
): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/plans/${requestId}`, {
    decision,
    followUpMode,
  })
}

export type JournalPage = { seq: number; ts: number; event: SillageEvent }[]

/**
 * Rattrapage complet depuis un curseur. La route est paginée, donc on boucle
 * jusqu'à rejoindre le dernier `seq` connu du serveur : s'arrêter à la première page
 * laisserait des trous invisibles dans le fil.
 *
 * Chaque page est rendue à l'appelant dès son arrivée plutôt qu'à la fin. Une
 * conversation de vingt mille événements en demande une quarantaine, et les attendre
 * toutes laissait l'écran vide le temps d'autant d'allers-retours enchaînés. Le fil
 * s'affiche maintenant dès la première et grandit jusqu'à sa fin.
 *
 * Les pages ne peuvent pas être demandées en parallèle : le curseur d'une page est le
 * dernier `seq` de la précédente, et `seq` comporte des trous après compaction des
 * deltas, donc il n'y a pas de découpage calculable à l'avance.
 */
export async function fetchJournal(
  conversationId: string,
  afterSeq: number,
  onPage: (entries: JournalPage) => void,
): Promise<void> {
  let cursor = afterSeq

  for (;;) {
    const page = await api.get<JournalPageDto>(
      `/api/conversations/${conversationId}/events?after=${cursor}`,
    )

    if (page.entries.length > 0) {
      onPage(
        page.entries.map((entry) => ({
          seq: entry.seq,
          ts: entry.ts,
          event: entry.event as SillageEvent,
        })),
      )
    }

    const last = page.entries.at(-1)
    if (!last || last.seq >= page.lastSeq) return
    cursor = last.seq
  }
}
