import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ExplorerFolderDto, ProjectFolderDto } from '@sillage/protocol'
import { api } from './api'
import { useCurrentUser } from './session'
import { encodeScope, type WorkspaceScope } from './workspace-scope'

interface FolderHistory {
  active: string | null
  recent: ExplorerFolderDto[]
}

const EMPTY: FolderHistory = { active: null, recent: [] }
const MAX_RECENT = 8
const storageKey = (userId: string, scope: WorkspaceScope) => `sillage.explorerFolders:${userId}:${scope}`

function readHistory(key: string): FolderHistory {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!Array.isArray(value?.recent)) return EMPTY
    const recent = value.recent.filter((item: ExplorerFolderDto | null) =>
      typeof item?.id === 'string' && typeof item.path === 'string',
    ).slice(0, MAX_RECENT)
    return { recent, active: typeof value.active === 'string' ? value.active : null }
  } catch {
    return EMPTY
  }
}

export function useExplorerFolderHistory(scope: WorkspaceScope): FolderHistory {
  const { data: user } = useCurrentUser()
  const key = storageKey(user?.id ?? '', scope)
  return useQuery({
    queryKey: [key],
    queryFn: () => readHistory(key),
    initialData: () => user ? readHistory(key) : EMPTY,
    staleTime: Infinity,
  }).data
}

type SelectableFolder = ExplorerFolderDto | ProjectFolderDto

export function folderScope(folder: SelectableFolder) {
  return encodeScope('projectId' in folder ? 'project-folder' : 'folder', folder.id)
}

/** Resolve shared roots against current membership. A detached folder cannot become a personal recent. */
export function useExplorerFolder(scope: WorkspaceScope, folders: ProjectFolderDto[] | undefined) {
  const { active, recent } = useExplorerFolderHistory(scope)
  return folders?.find(folder => folderScope(folder) === active)
    ?? recent.find(folder => folder.id === active)
    ?? null
}

export function useSelectExplorerFolder(scope: WorkspaceScope) {
  const { data: user } = useCurrentUser()
  const client = useQueryClient()
  return (folder: SelectableFolder | null) => {
    if (user) selectExplorerFolder(client, user.id, scope, folder)
  }
}

export function selectExplorerFolder(client: QueryClient, userId: string, scope: WorkspaceScope, folder: SelectableFolder | null) {
  const key = storageKey(userId, scope)
  const previous = client.getQueryData<FolderHistory>([key]) ?? readHistory(key)
  if (!folder && !previous.active) return
  const shared = folder && 'projectId' in folder
  const recent = folder && !shared
    ? [folder, ...previous.recent.filter(item => item.id !== folder.id)].slice(0, MAX_RECENT)
    : previous.recent
  const next = { active: shared ? folderScope(folder) : folder?.id ?? null, recent }
  client.setQueryData([key], next)
  try {
    localStorage.setItem(key, JSON.stringify(next))
  } catch { /* The open panel still keeps the choice in memory. */ }
}

export function useOpenExplorerFolder() {
  return useMutation({
    mutationFn: (path: string) => api.post<ExplorerFolderDto>('/api/explorer-folders', { path }),
  })
}
