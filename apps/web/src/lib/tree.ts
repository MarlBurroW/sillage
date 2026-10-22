import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'
import type { TreeListingDto, TreeSearchDto } from '@sillage/protocol'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'
import { wsClient } from './ws-client'

/**
 * One workspace tree level. Query per expanded directory rather than the entire tree:
 * `node_modules` alone is megabytes. Each level has its own cache entry, so collapsing and
 * reopening needs no new server query. Use `enabled` rather than conditional calls to keep hook
 * counts stable across renders.
 */
export function useTreeLevel(scope: WorkspaceScope, path: string, enabled: boolean) {
  // Watch disk while this level is displayed, catching writes outside Sillage, including panel
  // terminals and external editors. See `useTreeSync` for rereading.
  useEffect(() => {
    if (!enabled) return
    return wsClient.watchTree(scope, path)
  }, [scope, path, enabled])

  return useQuery({
    queryKey: ['tree', scope, path],
    queryFn: () =>
      api.get<TreeListingDto>(`${workspaceApiBase(scope)}/tree?path=${encodeURIComponent(path)}`),
    enabled,
    // Short rather than infinite: disk watches exist only while the panel is open, so remounted
    // levels must return to disk instead of frozen cache. Long enough for free collapse/reopen.
    staleTime: 30_000,
  })
}

/**
 * Reread levels the server reports changed on disk. Subscribe once for the explorer instead of once
 * per expanded directory: cache keys already handle that partitioning.
 */
export function useTreeSync(scope: WorkspaceScope): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      wsClient.onTreeChanged((changed, path) => {
        if (changed !== scope) return
        void queryClient.invalidateQueries({ queryKey: ['tree', scope, path] })
      }),
    [queryClient, scope],
  )
}

/**
 * Search filenames across the working directory. Separate query from the level-paginated tree
 * because search requires traversal. Disabled below two characters, where matches discriminate
 * poorly and traversal costs most.
 */
export function useFileSearch(scope: WorkspaceScope, query: string) {
  const trimmed = query.trim()
  return useQuery({
    queryKey: ['tree-search', scope, trimmed],
    queryFn: () =>
      api.get<TreeSearchDto>(
        `${workspaceApiBase(scope)}/tree/search?q=${encodeURIComponent(trimmed)}`,
      ),
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
  })
}

/** Invalidate all open levels and search within a scope at once. */
export function useRefreshTree(scope: WorkspaceScope): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['tree', scope] })
    // Search has a separate query and expiry: otherwise refresh leaves deleted files in results.
    void queryClient.invalidateQueries({ queryKey: ['tree-search', scope] })
  }, [queryClient, scope])
}
