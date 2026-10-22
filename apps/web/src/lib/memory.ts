import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MemoryMode, ProjectMemoryDto } from '@sillage/protocol'
import { api } from './api'

/** Reread on every opening: agents write without using the UI. */
const memoryKey = (projectId: string) => ['memory', projectId]

export function useProjectMemory(projectId: string) {
  return useQuery({
    queryKey: memoryKey(projectId),
    queryFn: () => api.get<ProjectMemoryDto>(`/api/projects/${projectId}/memory`),
  })
}

/** Project memory location, applied at the next runner launch. */
export function useSetMemoryMode(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (memoryMode: MemoryMode) => api.patch<{ ok: true }>(`/api/projects/${projectId}`, { memoryMode }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: memoryKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function useWriteMemoryFile(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, content }: { file: string; content: string }) =>
      api.put<void>(`/api/projects/${projectId}/memory/${encodeURIComponent(file)}`, { content }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: memoryKey(projectId) }),
  })
}

export function useDeleteMemoryFile(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (file: string) =>
      api.delete<void>(`/api/projects/${projectId}/memory/${encodeURIComponent(file)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: memoryKey(projectId) }),
  })
}

/** Note description read from its header, explaining its subject. */
export function memoryDescription(content: string): string | null {
  const head = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? ''
  const line = head.split('\n').find((candidate) => candidate.startsWith('description:'))
  return line ? line.slice('description:'.length).trim().replace(/^["']|["']$/g, '') : null
}
