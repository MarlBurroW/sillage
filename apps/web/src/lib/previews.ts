import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PREVIEW_SHARE_HOURS, PreviewCheckDto, PreviewListDto, PreviewOpenDto, PreviewShareDto, PreviewShareListDto, StoppedPreviewListDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Dev-server previews (card #113): what can be previewed, and opening one. Screens decide the
 * presentation: the conversation panel, the Services page.
 */
export function usePreviews() {
  return useQuery({
    queryKey: ['previews'],
    queryFn: () => api.get<PreviewListDto>('/api/previews'),
    // Dev servers start and stop as agents work.
    refetchInterval: 10_000,
  })
}

/** Each call signs in afresh: the returned link carries a token valid for a minute. */
export function useOpenPreview() {
  return useMutation({
    mutationFn: ({ port, path }: { port: number; path?: string | null }) => api.post<PreviewOpenDto>('/api/previews', { port, ...(path ? { path } : {}) }),
  })
}

/**
 * Opens a preview in a browser tab, signed in. The tab is opened before the request resolves,
 * or popup blockers would refuse it.
 */
export function useOpenPreviewInTab() {
  const open = useOpenPreview()
  return {
    pending: open.isPending,
    /** `path` is the page to land on, the root without it. */
    open: (port: number, path?: string | null) => {
      const tab = window.open('about:blank', '_blank')
      open.mutateAsync({ port, path }).then((result) => { if (tab) tab.location.href = result.url }, () => tab?.close())
    },
  }
}

/** Servers this conversation ran and did not hide, listening or not; the thread tells them apart. */
export function useConversationPreviews(conversationId: string, enabled = true) {
  return useQuery({
    queryKey: ['previews', 'conversation', conversationId],
    queryFn: () => api.get<StoppedPreviewListDto>(`/api/previews/conversations/${conversationId}`),
    select: (data) => data.previews,
    // Follows the list of listening servers, so a server that stops turns into its line at once.
    refetchInterval: 10_000,
    enabled,
  })
}

/** Removes a stopped server's line; it comes back if the server listens again. */
export function useDismissStoppedPreview(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (port: number) => api.delete<void>(`/api/previews/conversations/${conversationId}/${port}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['previews', 'conversation', conversationId] }),
  })
}

const SHARES_KEY = ['preview-shares']

/** The account's public demo links, recent expired and revoked ones included. */
export function usePreviewShares(enabled = true) {
  return useQuery({
    queryKey: SHARES_KEY,
    queryFn: () => api.get<PreviewShareListDto>('/api/previews/shares'),
    select: (data) => data.shares,
    enabled,
  })
}

export function useCreatePreviewShare() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { port: number; hours: (typeof PREVIEW_SHARE_HOURS)[number] }) => api.post<PreviewShareDto>('/api/previews/shares', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SHARES_KEY }),
  })
}

export function useRevokePreviewShare() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/previews/shares/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SHARES_KEY }),
  })
}

/** Admin routing check: which link of DNS, certificate and proxy fails, if any. */
export function useCheckPreviews() {
  return useMutation({ mutationFn: () => api.post<PreviewCheckDto>('/api/previews/check') })
}

export const PREVIEWS_DOCS_URL = 'https://github.com/MarlBurroW/sillage/blob/main/docs/previews.md'
