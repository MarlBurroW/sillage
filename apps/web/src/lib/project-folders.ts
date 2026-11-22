import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectFolderDto } from '@sillage/protocol'
import { api } from './api'

const foldersKey = (projectId?: string | null) => ['project-folders', projectId]

export function useProjectFolders(projectId?: string | null) {
  return useQuery({
    queryKey: foldersKey(projectId),
    queryFn: () => api.get<ProjectFolderDto[]>(`/api/projects/${projectId}/folders`),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  })
}

export function useAttachProjectFolder(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => api.post<ProjectFolderDto>(`/api/projects/${projectId}/folders`, { path }),
    onSuccess: () => client.invalidateQueries({ queryKey: foldersKey(projectId) }),
  })
}

export function useDetachProjectFolder(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (folderId: string) => api.delete<void>(`/api/projects/${projectId}/folders/${folderId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: foldersKey(projectId) }),
  })
}
