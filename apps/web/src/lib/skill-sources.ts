import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateSkillSourceBody,
  InstallSourceSkillBody,
  LibrarySkillDto,
  LibrarySkillUpdateDto,
  SkillSearchDto,
  SkillSourceCatalogDto,
  SkillSourceDto,
  SkillSourceListDto,
  SourceSkillPreviewDto,
  UpdateSkillSourceBody,
} from '@sillage/protocol'
import { api } from './api'

/**
 * Skill library sources. Refreshing a source changes known updates, so every write invalidates both
 * roots.
 */

const ROOT = ['skill-sources']
const LIBRARY = ['skill-library']

export function useSkillSources() {
  return useQuery({
    queryKey: [...ROOT, 'list'],
    queryFn: () => api.get<SkillSourceListDto>('/api/skill-sources'),
    staleTime: 30_000,
  })
}

export function useSourceCatalog(id: string | null) {
  return useQuery({
    queryKey: [...ROOT, 'catalog', id],
    queryFn: () => api.get<SkillSourceCatalogDto>(`/api/skill-sources/${id}/catalog`),
    enabled: id !== null,
  })
}

export function useSourcePreview(id: string | null, path: string | null) {
  return useQuery({
    queryKey: [...ROOT, 'preview', id, path],
    queryFn: () =>
      api.get<SourceSkillPreviewDto>(`/api/skill-sources/${id}/preview?path=${encodeURIComponent(path ?? '')}`),
    enabled: id !== null && path !== null,
  })
}

/** Search skills.sh from two characters onward. */
export function useSkillSearch(query: string) {
  const trimmed = query.trim()
  return useQuery({
    queryKey: [...ROOT, 'search', trimmed],
    queryFn: () => api.get<SkillSearchDto>(`/api/skill-sources/search?q=${encodeURIComponent(trimmed)}`),
    enabled: trimmed.length >= 2,
    staleTime: 5 * 60_000,
  })
}

/** Update diff reread on every opening because the source may have changed. */
export function useSkillUpdate(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...LIBRARY, 'update', id],
    queryFn: () => api.get<LibrarySkillUpdateDto>(`/api/skill-library/${id}/update`),
    enabled,
    staleTime: 0,
  })
}

function useSourceMutation<Input, Output>(run: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOT })
      await queryClient.invalidateQueries({ queryKey: LIBRARY })
    },
  })
}

export const useCreateSkillSource = () =>
  useSourceMutation((input: Partial<CreateSkillSourceBody> & { url: string }) =>
    api.post<SkillSourceDto>('/api/skill-sources', input),
  )

export const useUpdateSkillSource = () =>
  useSourceMutation(({ id, ...patch }: { id: string } & UpdateSkillSourceBody) =>
    api.patch<SkillSourceDto>(`/api/skill-sources/${id}`, patch),
  )

export const useDeleteSkillSource = () =>
  useSourceMutation((id: string) => api.delete<void>(`/api/skill-sources/${id}`))

export const useRefreshSkillSource = () =>
  useSourceMutation((id: string) => api.post<SkillSourceDto>(`/api/skill-sources/${id}/refresh`))

export const useInstallSourceSkill = () =>
  useSourceMutation(({ sourceId, ...body }: { sourceId: string } & InstallSourceSkillBody) =>
    api.post<LibrarySkillDto>(`/api/skill-sources/${sourceId}/install`, body),
  )

export const useApplySkillUpdate = () =>
  useSourceMutation((id: string) => api.post<LibrarySkillDto>(`/api/skill-library/${id}/update`))

/** First seven characters, as displayed by Git. */
export function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 7) : ''
}
