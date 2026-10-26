import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConversationDto, PersonalWorkspaceDto } from '@sillage/protocol'
import { api } from './api'
import type { CreateProjectInput } from './projects'

export function usePersonalWorkspaces() {
  return useQuery({ queryKey: ['personal-workspaces'], queryFn: () => api.get<PersonalWorkspaceDto[]>('/api/discussions/workspaces') })
}

export function useDeletePersonalWorkspace() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/personal-workspaces/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['personal-workspaces'] }),
  })
}

export function useContinueInProject(conversationId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { project: CreateProjectInput; brief: string; files: string[] }) =>
      api.post<ConversationDto>(`/api/conversations/${conversationId}/project`, input),
    onSuccess: async () => {
      await Promise.all(['projects', 'conversations', 'user-settings'].map(key => client.invalidateQueries({ queryKey: [key] })))
    },
  })
}
