import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClaudeSandboxSupportDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Whether the host can run Claude Code's Bash sandbox. The server asks the CLI itself and caches
 * the answer: each check starts a CLI process, so the composer reads it rarely.
 */

const KEY = ['claude-sandbox-support']

export function useClaudeSandboxSupport(enabled: boolean) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ClaudeSandboxSupportDto>('/api/agents/claude/sandbox'),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Checks again, after the missing packages were installed. */
export function useRefreshClaudeSandboxSupport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.get<ClaudeSandboxSupportDto>('/api/agents/claude/sandbox?refresh=1'),
    onSuccess: (support) => queryClient.setQueryData(KEY, support),
  })
}
