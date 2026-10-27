import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentKind, AgentUsage, UsageWindow } from '@sillage/protocol'
import { api } from './api'

/** `account` identifies an additional Claude account, null for the CLI login. */
const usageKey = (agent: AgentKind, account: string | null) => ['usage', agent, account]

const usagePath = (agent: AgentKind, account: string | null, refresh: boolean) => {
  const params = new URLSearchParams()
  if (account) params.set('account', account)
  if (refresh) params.set('refresh', '1')
  const query = params.toString()
  return `/api/agents/${agent}/usage${query ? `?${query}` : ''}`
}

/**
 * Account usage. `staleTime` is zero because the hook mounts only while the panel is open: refetch
 * on every opening. The real cost is server-side (a read starts a CLI process), so cache there;
 * layered caches obscure freshness and make refresh seem ineffective. Keep previous data cached
 * during refetch so reopening shows it immediately. `enabled` serves callers showing usage without
 * an explicit request, such as drafts: probing missing CLIs would only yield errors.
 */
export function useAgentUsage(agent: AgentKind, enabled = true, account: string | null = null) {
  return useQuery({
    queryKey: usageKey(agent, account),
    queryFn: () => api.get<AgentUsage>(usagePath(agent, account, false)),
    enabled,
    staleTime: 0,
    // Usage does not fluctuate abruptly: retry loops would only launch pointless CLI processes.
    retry: false,
  })
}

/** Explicit refetch, bypassing the server cache too. */
export function useRefreshUsage(agent: AgentKind, account: string | null = null) {
  const queryClient = useQueryClient()

  return async () => {
    const fresh = await api.get<AgentUsage>(usagePath(agent, account, true))
    queryClient.setQueryData(usageKey(agent, account), fresh)
  }
}

/** Most loaded windows first: the figures that decide which account to pick. */
export function busiestWindows(usage: AgentUsage, count = 2): (UsageWindow & { utilization: number })[] {
  return usage.windows
    .filter((window): window is UsageWindow & { utilization: number } => window.utilization !== null)
    .sort((a, b) => b.utilization - a.utilization)
    .slice(0, count)
}

/** Additional account selected by configuration, null for the CLI login. */
export function usageAccountOf(config: { agent: AgentKind; account?: string | null } | null | undefined): string | null {
  return config?.agent === 'claude' || config?.agent === 'codex' || config?.agent === 'grok' || config?.agent === 'antigravity' ? (config.account ?? null) : null
}

/**
 * Usage for several accounts of one CLI at once for comparison before selection. Shares keys and
 * cache with `useAgentUsage`: detailed usage for the selected account does not repeat the read, and
 * server limits still bound probes.
 */
export function useAccountsUsage(agent: AgentKind, accounts: (string | null)[], enabled: boolean) {
  return useQueries({
    queries: accounts.map((account) => ({
      queryKey: usageKey(agent, account),
      queryFn: () => api.get<AgentUsage>(usagePath(agent, account, false)),
      enabled,
      staleTime: 0,
      retry: false,
    })),
  })
}
