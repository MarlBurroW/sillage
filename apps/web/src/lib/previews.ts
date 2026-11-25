import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PREVIEW_SHARE_HOURS, PreviewListDto, PreviewOpenDto, PreviewShareDto, PreviewShareListDto } from '@sillage/protocol'
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
    mutationFn: (port: number) => api.post<PreviewOpenDto>('/api/previews', { port }),
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
