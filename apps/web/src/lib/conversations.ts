import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentConfig,
  ElicitationAction,
  ElicitationValue,
  ConversationDto,
  HandoffDto,
  JournalPageDto,
  SillageEvent,
} from '@sillage/protocol'
import { api } from './api'
import { uuidv4 } from './uuid'

export const conversationsKey = (projectId: string) => ['conversations', projectId]
const ALL_CONVERSATIONS_KEY = ['conversations', 'all']

/** All visible conversations for the sidebar. One query rather than one per project. */
export function useAllConversations(enabled = true) {
  return useQuery({
    queryKey: ALL_CONVERSATIONS_KEY,
    enabled,
    queryFn: () => api.get<ConversationDto[]>('/api/conversations'),
    staleTime: 10_000,
  })
}

/**
 * Manual order within a project. Apply it locally before the server replies: waiting for a network
 * round trip makes drag-and-drop visibly laggy.
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

      // Leave other projects' conversations in place: put the reordered project conversations back
      // in their existing slots.
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
      // Server rejection: restore the order known by the server.
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

/**
 * Add or remove a personal bookmark. Apply locally before the reply: starring is a navigation
 * action, and a delayed star looks like a missed click. Update both cached lists because the
 * sidebar and project page read different ones.
 */
export function useToggleFavorite() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      favorite
        ? api.put<{ favorite: boolean }>(`/api/conversations/${id}/favorite`, {})
        : api.delete<{ favorite: boolean }>(`/api/conversations/${id}/favorite`),

    onMutate: async ({ id, favorite }) => {
      await queryClient.cancelQueries({ queryKey: ['conversations'] })
      const previous = queryClient.getQueriesData<ConversationDto[]>({ queryKey: ['conversations'] })

      for (const [key, list] of previous) {
        if (!list) continue
        queryClient.setQueryData(
          key,
          list.map((entry) => (entry.id === id ? { ...entry, favorite } : entry)),
        )
      }

      return { previous }
    },

    onError: (_error, { id }, context) => {
      // A read or status change may arrive during the request. Rolling back the bookmark must not
      // restore the entire old list.
      for (const [key, list] of context?.previous ?? []) {
        const previous = list?.find((entry) => entry.id === id)
        if (!previous) continue
        queryClient.setQueryData<ConversationDto[]>(key, (current) =>
          current?.map((entry) => entry.id === id ? { ...entry, favorite: previous.favorite } : entry),
        )
      }
    },

    onSettled: (_result, _error, { id }) => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['conversations'] }),
      queryClient.invalidateQueries({ queryKey: ['conversation', id] }),
    ]),
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
      /** null means the project directory without a worktree. */
      worktreeId?: string | null
      /** Associated card when the draft was opened from the board. */
      cardId?: string | null
      /** Sent with creation: without a message, no conversation is written. */
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
        cardId: null,
        ...input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      // Starting from a card adds a session and may move its column: reread or the board behind would be stale.
      void queryClient.invalidateQueries({ queryKey: ['cards'] })
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
    // Stable client ID: the server ignores a retry after network timeout instead of posting twice (invariant I5).
    clientMessageId: uuidv4(),
    text,
    attachmentIds,
    mentions,
    skills,
  })
}

/**
 * Steer the current turn instead of opening the next. Available only for supporting CLIs: the
 * server explicitly rejects when no turn is running instead of falling back to queueing.
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

/** Ask the agent to summarize the conversation to free context. */
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
 * Fork the conversation at a thread position. `throughSeq` is the last retained event: history and
 * agent state resume from that point.
 */
export function forkConversation(
  conversationId: string,
  throughSeq: number,
): Promise<ConversationDto> {
  return api.post<ConversationDto>(`/api/conversations/${conversationId}/fork`, { throughSeq })
}

/**
 * Continue the conversation in another CLI. Create the continuation without a message: the next
 * request is written in its composer, and the selected context is sent with it on the first turn.
 */
export function handoffConversation(
  conversationId: string,
  body: { agent: AgentConfig['agent']; config: AgentConfig; budgetTokens?: number },
): Promise<ConversationDto> {
  return api.post<ConversationDto>(`/api/conversations/${conversationId}/handoff`, body)
}

/** Context received from a continuation's source; absent in other conversations. */
export function useHandoff(conversationId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['conversation', conversationId, 'handoff'],
    queryFn: () => api.get<HandoffDto>(`/api/conversations/${conversationId}/handoff`),
    enabled: Boolean(conversationId) && enabled,
    staleTime: Infinity,
  })
}

/** Remove a queued message before sending it to the CLI. */
export function cancelQueuedMessage(conversationId: string, queueId: string): Promise<unknown> {
  return api.delete(`/api/conversations/${conversationId}/queue/${queueId}`)
}

/** Move a queued message into the current turn instead of the next. */
export function steerQueuedMessage(conversationId: string, queueId: string): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/queue/${queueId}/steer`)
}

/** Deliver a held session message despite the safeguards that stopped it. */
export function releaseSessionMessage(conversationId: string, messageId: string): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/session-messages/${messageId}/release`)
}

export function discardSessionMessage(conversationId: string, messageId: string): Promise<unknown> {
  return api.delete(`/api/conversations/${conversationId}/session-messages/${messageId}`)
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
  /** The plan's follow-up option `id`, opaque to the client. */
  followUpMode: string | null,
): Promise<unknown> {
  return api.post(`/api/conversations/${conversationId}/plans/${requestId}`, {
    decision,
    followUpMode,
  })
}

export type JournalPage = { seq: number; ts: number; event: SillageEvent }[]

/**
 * Catch up fully from a cursor. The route is paginated, so loop until reaching the server's latest
 * `seq`; stopping at the first page would leave invisible thread gaps. Deliver pages as they arrive
 * rather than waiting for all of them, so folding yields between pages while the initial thread
 * stays hidden. Pages cannot be requested in parallel: each cursor is the
 * previous page's last read `seq`, which cannot be predicted because merged deltas mean pages
 * return fewer entries than they read. Return the last read `seq`, distinct from the last returned
 * entry, for the WebSocket subscription cursor.
 */
export async function fetchJournal(
  conversationId: string,
  afterSeq: number,
  onPage: (entries: JournalPage, readThrough: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  let cursor = afterSeq

  for (;;) {
    signal?.throwIfAborted()
    const page = await api.get<JournalPageDto>(
      `/api/conversations/${conversationId}/events?after=${cursor}&bodies=1`,
      signal,
    )
    signal?.throwIfAborted()

    // The web app can deploy without restarting the server. Older servers omit `nextAfter`, so fall
    // back to the last returned entry as before; advancing to `undefined` would reread the first
    // page forever.
    const next = page.nextAfter ?? page.entries.at(-1)?.seq ?? cursor
    // Commit every examined cursor, even for filtered-out pages. A failed later page
    // can then resume without replaying already-coalesced deltas.
    onPage(page.entries.map((entry) => ({
      seq: entry.seq,
      ts: entry.ts,
      event: entry.event as SillageEvent,
    })), next)
    signal?.throwIfAborted()

    // Stop if a page makes no progress: otherwise a server returning a stationary cursor would loop
    // on the same page indefinitely.
    if (next <= cursor || next >= page.lastSeq) return Math.max(cursor, next)
    cursor = next
  }
}
