import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type {
  CreateSkillSourceBody,
  InstallSourceSkillBody,
  LibrarySkillDto,
  LibrarySkillUpdateDto,
  SkillSearchDto,
  SkillSearchResultDto,
  SkillSourceCatalogDto,
  SkillSourceDto,
  SkillSourceListDto,
  SourceSkillPreviewDto,
  SourceSkillDto,
  UpdateSkillSourceBody,
} from '@sillage/protocol'
import { api, ApiRequestError } from './api'
import { translate } from './i18n'

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
export function useSkillSearch(query: string, enabled = true) {
  const trimmed = query.trim()
  return useQuery({
    queryKey: [...ROOT, 'search', trimmed],
    queryFn: () => api.get<SkillSearchDto>(`/api/skill-sources/search?q=${encodeURIComponent(trimmed)}`),
    enabled: enabled && trimmed.length >= 2,
    staleTime: 5 * 60_000,
  })
}

export type DiscoverableSkill =
  | { kind: 'directory'; result: SkillSearchResultDto }
  | { kind: 'source'; source: SkillSourceDto; skill: SourceSkillDto }

/** Search all fetched catalogs, keeping partial failures visible to callers. */
export function useSavedSkillSearch(query: string, enabled: boolean) {
  const sources = useSkillSources()
  const fetched = (sources.data?.sources ?? []).filter((source) => source.enabled && source.lastCommit)
  const catalogs = useQueries({ queries: fetched.map((source) => ({
    queryKey: [...ROOT, 'catalog', source.id],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<SkillSourceCatalogDto>(`/api/skill-sources/${source.id}/catalog`, signal),
    enabled,
    staleTime: 30_000,
  })) })
  const needle = query.trim().toLocaleLowerCase()
  return {
    results: catalogs.flatMap((catalog) => (catalog.data?.skills ?? [])
      .filter((skill) => !needle || `${skill.name} ${skill.description} ${skill.path}`.toLocaleLowerCase().includes(needle))
      .map((skill): DiscoverableSkill => ({ kind: 'source', source: catalog.data!.source, skill }))),
    loading: sources.isLoading || catalogs.some((catalog) => catalog.isFetching),
    errors: [sources.error, ...catalogs.map((catalog) => catalog.error)].filter((error) => error !== null),
    unfetched: (sources.data?.sources ?? []).filter((source) => source.enabled && !source.lastCommit).length,
  }
}

const repositoryKey = (url: string) => url.trim().toLowerCase()
  .replace(/^https?:\/\/github\.com\//, '').replace(/^git@github\.com:/, '')
  .replace(/\/$/, '').replace(/\.git$/, '')

/** Keep discovery on the chosen skill throughout source retrieval, retries and installation. */
export function useInstallDiscoveredSkill() {
  const queryClient = useQueryClient()
  const create = useCreateSkillSource()
  const refresh = useRefreshSkillSource()
  const install = useInstallSourceSkill()
  const [phase, setPhase] = useState<'source' | 'skill' | null>(null)
  const mutation = useMutation({
    mutationFn: async ({ candidate, scope, projectId, name }: {
      candidate: DiscoverableSkill
      scope: InstallSourceSkillBody['scope']
      projectId: string | null
      name?: string
    }) => {
      setPhase('source')
      const { sources } = await api.get<SkillSourceListDto>('/api/skill-sources')
      let source = candidate.kind === 'source'
        ? sources.find((entry) => entry.id === candidate.source.id)
        : sources.find((entry) => repositoryKey(entry.url) === repositoryKey(candidate.result.repository))
      if (!source && candidate.kind === 'source') throw new Error(translate('skills.install.sourceMissing'))
      if (!source && candidate.kind === 'directory') {
        try {
          source = await create.mutateAsync({ url: candidate.result.repository })
        } catch (error) {
          // Another tab may have registered the same repository while this request was in flight.
          if (!(error instanceof ApiRequestError) || error.status !== 409) throw error
          source = (await api.get<SkillSourceListDto>('/api/skill-sources')).sources
            .find((entry) => repositoryKey(entry.url) === repositoryKey(candidate.result.repository))
          if (!source) throw error
        }
      }
      if (!source) throw new Error(translate('skills.install.sourceMissing'))
      if (!source.enabled) throw new Error(translate('skills.search.sourceDisabled'))
      // Directory indexes may be newer than a saved catalog. Refresh before resolving its name.
      if (candidate.kind === 'directory' || !source.lastCommit) {
        await refresh.mutateAsync(source.id)
      }
      const catalog = await api.get<SkillSourceCatalogDto>(`/api/skill-sources/${source.id}/catalog`)
      const matches = candidate.kind === 'source'
        ? catalog.skills.filter((skill) => skill.path === candidate.skill.path)
        : catalog.skills.filter((skill) => skill.name === candidate.result.name || skill.path.split('/').pop() === candidate.result.name)
      if (matches.length !== 1) throw new Error(translate(matches.length === 0 ? 'skills.install.missing' : 'skills.install.ambiguous', {
        name: candidate.kind === 'source' ? candidate.skill.name : candidate.result.name,
        source: source.name,
      }))
      const skill = matches[0]!
      setPhase('skill')
      // A retry after a lost HTTP response must not create a second copy.
      const existing = skill.installed.find((entry) => entry.scope === scope && entry.projectId === projectId && entry.name === (name ?? skill.name))
      if (existing) return { id: existing.skillId, name: existing.name }
      return install.mutateAsync({
        sourceId: source.id, path: skill.path, scope, projectId, ...(name ? { name } : {}),
      })
    },
    onSettled: async () => {
      setPhase(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ROOT }),
        queryClient.invalidateQueries({ queryKey: LIBRARY }),
      ])
    },
  })
  return { ...mutation, phase }
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
