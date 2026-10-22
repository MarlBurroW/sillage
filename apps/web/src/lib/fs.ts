import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FsEntryDto, FsListingDto } from '@sillage/protocol'
import { api } from './api'

export function useDirectoryListing(path: string | null, showHidden: boolean) {
  return useQuery({
    queryKey: ['fs', path, showHidden],
    queryFn: () => {
      const params = new URLSearchParams()
      if (path) params.set('path', path)
      if (showHidden) params.set('showHidden', 'true')
      return api.get<FsListingDto>(`/api/fs/browse?${params}`)
    },
    // Disk contents change independently: avoid long caching but retain the previous listing during
    // the next load to prevent flashing.
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  })
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
