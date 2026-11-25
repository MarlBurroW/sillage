import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  InstructionsDto,
  InstructionsMode,
  ProjectInstructionsDto,
  RepoInstructionFile,
  RepoInstructionFileDto,
} from '@sillage/protocol'
import { api } from './api'

/** Where a project's instructions are kept, and the repository file read when that is the place. */
export interface InstructionsPlace {
  mode: InstructionsMode
  file: RepoInstructionFile
}

/** The first file present, else AGENTS.md, the one the editor creates. */
export function placeOf(data: ProjectInstructionsDto): InstructionsPlace {
  return { mode: data.mode, file: data.repoFiles[0]?.path ?? 'AGENTS.md' }
}

/**
 * SILLAGE.md global and project sections. Reread on every opening instead of long caching because
 * agents may have added instructions through MCP since the last visit.
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

/** Undefined while loading. Shares the editor's query, so a mode change shows everywhere at once. */
export function useInstructionsPlace(projectId: string | undefined): InstructionsPlace | undefined {
  const { data } = useProjectInstructions(projectId)
  return data ? placeOf(data) : undefined
}

export function useUpdateProjectInstructions(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { mode?: InstructionsMode; content?: string }) =>
      api.patch<ProjectInstructionsDto>(`/api/projects/${projectId}/instructions`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(projectKey(projectId), data)
      // The mode is also present on the project.
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
 * Migration import text: repository files appended to existing SILLAGE.md content. Identical files,
 * such as AGENTS.md linking to CLAUDE.md, count only once.
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
