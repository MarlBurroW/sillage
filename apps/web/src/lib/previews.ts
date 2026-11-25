import { useMutation, useQuery } from '@tanstack/react-query'
import type { PreviewListDto, PreviewOpenDto } from '@sillage/protocol'
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
