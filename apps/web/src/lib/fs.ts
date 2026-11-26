import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FsEntryDto, FsListingDto } from '@sillage/protocol'
import { api } from './api'
import { useDebounced } from './search'

export function readDirectory(path: string | null, showHidden: boolean) {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  if (showHidden) params.set('showHidden', 'true')
  return api.get<FsListingDto>(`/api/fs/browse?${params}`)
}

export function useDirectoryListing(path: string | null, showHidden: boolean) {
  return useQuery({
    queryKey: ['fs', path, showHidden],
    queryFn: () => readDirectory(path, showHidden),
    // Disk contents change independently: avoid long caching but retain the previous listing during
    // the next load to prevent flashing.
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  })
}

/**
 * Whether a typed folder is a project root (.git, package.json…), read once typing pauses.
 * False while the path is partial or missing: the caller only warns on a confirmed answer.
 */
export function useLooksLikeProject(path: string): boolean {
  const settled = useDebounced(path.trim().replace(/(.)[\\/]+$/, '$1'))
  const absolute = settled.startsWith('/') || /^[A-Za-z]:[\\/]/.test(settled)
  const { data } = useQuery({
    queryKey: ['fs', settled, false],
    queryFn: () => readDirectory(settled, false),
    enabled: absolute,
    staleTime: 5_000,
    retry: false,
  })
  return absolute && data?.looksLikeProject === true
}

/** Create a directory in `path` and invalidate all open listings to reflect it. */
export function useCreateDirectory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { path: string; name: string }) =>
      api.post<FsEntryDto>('/api/fs/mkdir', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fs'] }),
  })
}

/**
 * Split absolute paths into clickable breadcrumbs. Windows paths (`C:\Users\…`) start with their
 * drive as the root.
 */
export function breadcrumbSegments(path: string): { label: string; path: string }[] {
  const drive = /^([A-Za-z]:)[\\/]/.exec(path)
  if (drive) {
    const root = `${drive[1]}\\`
    const rest = path.slice(drive[0].length).split(/[\\/]/).filter(Boolean)
    return [
      { label: drive[1]!, path: root },
      ...rest.map((label, index) => ({ label, path: `${root}${rest.slice(0, index + 1).join('\\')}` })),
    ]
  }
  const parts = path.split('/').filter(Boolean)
  return parts.map((label, index) => ({
    label,
    path: `/${parts.slice(0, index + 1).join('/')}`,
  }))
}
