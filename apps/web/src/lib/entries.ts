import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Explorer file and directory operations. Invalidate the entire tree rather than just the touched
 * level: moves affect two levels, deletion may alter ancestor Git state, and client dependency
 * calculation would duplicate server knowledge.
 */
function useEntryMutation<T, R = unknown>(scope: WorkspaceScope, run: (input: T) => Promise<R>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tree', scope] }),
  })
}

export function useCreateEntry(scope: WorkspaceScope) {
  return useEntryMutation<{ parent: string; name: string; kind: 'file' | 'directory' }, { path: string }>(
    scope,
    (body) => api.post<{ path: string }>(`${workspaceApiBase(scope)}/entries`, body),
  )
}

/** Rename and move are the same operation; only the destination path differs. */
export function useMoveEntry(scope: WorkspaceScope) {
  return useEntryMutation<{ from: string; to: string }>(scope, (body) =>
    api.post(`${workspaceApiBase(scope)}/entries/move`, body),
  )
}

export function useDeleteEntry(scope: WorkspaceScope) {
  return useEntryMutation<{ path: string }>(scope, (body) =>
    api.delete(`${workspaceApiBase(scope)}/entries`, body),
  )
}

export type EntryOperation =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'copy'; from: string; toParent: string }
  | { kind: 'delete'; path: string }

export interface OperationsOutcome {
  /** Each successful operation and its resulting path. */
  done: Array<{ operation: EntryOperation; path: string }>
  failures: Error[]
}

async function runOperation(scope: WorkspaceScope, operation: EntryOperation): Promise<string> {
  const base = workspaceApiBase(scope)
  switch (operation.kind) {
    case 'move':
      await api.post(`${base}/entries/move`, { from: operation.from, to: operation.to })
      return operation.to
    case 'copy': {
      const { from, toParent } = operation
      return (await api.post<{ path: string }>(`${base}/entries/copy`, { from, toParent })).path
    }
    case 'delete':
      await api.delete(`${base}/entries`, { path: operation.path })
      return operation.path
  }
}

/**
 * Bulk move, paste, or delete operations. Send sequentially: concurrent copies to one directory
 * would race for the same free name. Continue after errors because selection is not a transaction:
 * successes remain and must appear. Return rather than throw failures for the same reason, and
 * reread the tree once at the end.
 */
export function useEntryOperations(scope: WorkspaceScope) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (operations: EntryOperation[]): Promise<OperationsOutcome> => {
      const outcome: OperationsOutcome = { done: [], failures: [] }
      for (const operation of operations) {
        try {
          outcome.done.push({ operation, path: await runOperation(scope, operation) })
        } catch (err) {
          outcome.failures.push(err instanceof Error ? err : new Error(String(err)))
        }
      }
      return outcome
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['tree', scope] })
      void queryClient.invalidateQueries({ queryKey: ['tree-search', scope] })
    },
  })
}

/** Parent directory of a relative path, empty at root. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/** Same directory, different name. */
export function siblingPath(path: string, name: string): string {
  const parent = parentOf(path)
  return parent ? `${parent}/${name}` : name
}
