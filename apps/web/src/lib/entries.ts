import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Manipulations de fichiers et de dossiers depuis l'explorateur.
 *
 * Chaque opération invalide l'arborescence entière plutôt que le seul niveau touché :
 * un déplacement change deux niveaux, une suppression peut vider l'état git d'un
 * ancêtre, et recalculer ces dépendances côté client reproduirait ce que le serveur
 * sait déjà.
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

/** Renommer et déplacer sont la même opération : seul le chemin de destination change. */
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
  /** Chaque opération réussie, et le chemin où elle a abouti. */
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
 * Plusieurs manipulations d'un coup : une sélection déplacée, collée ou supprimée.
 *
 * Envoyées l'une après l'autre plutôt qu'ensemble : deux copies vers un même dossier se
 * disputeraient le même nom libre. Une erreur n'arrête pas les suivantes, la sélection
 * n'étant pas une transaction : ce qui a réussi reste fait, et doit apparaître. Les
 * échecs sont rendus plutôt que levés pour la même raison, et l'arborescence n'est
 * relue qu'une fois, à la fin.
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

/** Dossier parent d'un chemin relatif, chaîne vide à la racine. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/** Même dossier, autre nom. */
export function siblingPath(path: string, name: string): string {
  const parent = parentOf(path)
  return parent ? `${parent}/${name}` : name
}
