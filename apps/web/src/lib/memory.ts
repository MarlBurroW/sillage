import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectMemoryDto } from '@sillage/protocol'
import { api } from './api'

/** Relue à chaque ouverture : les agents y écrivent sans passer par l'interface. */
const memoryKey = (projectId: string) => ['memory', projectId]

export function useProjectMemory(projectId: string) {
  return useQuery({
    queryKey: memoryKey(projectId),
    queryFn: () => api.get<ProjectMemoryDto>(`/api/projects/${projectId}/memory`),
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

/** La description d'une note, lue dans son en-tête : c'est ce qui dit de quoi elle parle. */
export function memoryDescription(content: string): string | null {
  const head = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? ''
  const line = head.split('\n').find((candidate) => candidate.startsWith('description:'))
  return line ? line.slice('description:'.length).trim().replace(/^["']|["']$/g, '') : null
}
