import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  InstructionsDto,
  InstructionsMode,
  ProjectInstructionsDto,
  RepoInstructionFile,
  RepoInstructionFileDto,
} from '@sillage/protocol'
import { api } from './api'

/**
 * SILLAGE.md : la partie globale et celle d'un projet.
 *
 * Relu à chaque ouverture plutôt que gardé longtemps : un agent peut y avoir ajouté une
 * consigne par les outils MCP depuis la dernière visite.
 */
const GLOBAL_KEY = ['instructions', 'global']
const projectKey = (projectId: string) => ['instructions', 'project', projectId]

export function useGlobalInstructions() {
  return useQuery({
    queryKey: GLOBAL_KEY,
    queryFn: () => api.get<InstructionsDto>('/api/instructions'),
  })
}

export function useSaveGlobalInstructions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (content: string) => api.put<InstructionsDto>('/api/instructions', { content }),
    onSuccess: (data) => queryClient.setQueryData(GLOBAL_KEY, data),
  })
}

export function useProjectInstructions(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKey(projectId ?? ''),
    queryFn: () => api.get<ProjectInstructionsDto>(`/api/projects/${projectId}/instructions`),
    enabled: Boolean(projectId),
  })
}

export function useUpdateProjectInstructions(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { mode?: InstructionsMode; content?: string }) =>
      api.patch<ProjectInstructionsDto>(`/api/projects/${projectId}/instructions`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(projectKey(projectId), data)
      // Le mode figure aussi sur le projet.
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function useWriteRepoInstructions(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { path: RepoInstructionFile; content: string }) =>
      api.put<RepoInstructionFileDto>(`/api/projects/${projectId}/instructions/repo-file`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: projectKey(projectId) }),
  })
}

/**
 * Le texte qu'importe la migration : les fichiers du dépôt à la suite de ce que SILLAGE.md
 * porte déjà. Deux fichiers au contenu identique, comme un `AGENTS.md` qui n'est qu'un
 * lien vers `CLAUDE.md`, ne comptent qu'une fois.
 */
export function mergedForImport(current: string, files: RepoInstructionFileDto[]): string {
  const seen = new Set<string>()
  const parts = [current.trim()]
  for (const file of files) {
    const text = file.content.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    parts.push(text)
  }
  return parts.filter(Boolean).join('\n\n')
}
