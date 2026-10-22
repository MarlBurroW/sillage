import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UpdateStatus, VersionInfo } from '@sillage/protocol'
import { api } from './api'
import { useCurrentUser } from './session'

const VERSION_KEY = ['system', 'version']
const UPDATE_KEY = ['system', 'update']

const versionQuery = {
  queryKey: VERSION_KEY,
  queryFn: () => api.get<VersionInfo>('/api/system/version'),
  // The server already caches GitHub replies for an hour: avoid requesting on every settings navigation.
  staleTime: 30 * 60 * 1000,
}

export function useVersionInfo() {
  return useQuery(versionQuery)
}

/**
 * Whether an update awaits an administrator: only administrators can launch it, so do not prompt
 * others. The sidebar uses this, checking at app opening rather than only in settings; server
 * caching still limits GitHub to one request per hour.
 */
export function useUpdateNotice(): boolean {
  const { data: user } = useCurrentUser()
  const isAdmin = user?.isAdmin === true
  const { data } = useQuery({ ...versionQuery, enabled: isAdmin })
  return isAdmin && data?.updateAvailable === true
}

/** Forced administrator refresh bypassing the one-hour server cache. */
export function useRefreshVersionInfo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.get<VersionInfo>('/api/system/version?refresh=1'),
    onSuccess: (info) => queryClient.setQueryData(VERSION_KEY, info),
  })
}

export function useStartUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<UpdateStatus>('/api/system/update'),
    onSuccess: (status) => queryClient.setQueryData(UPDATE_KEY, status),
  })
}

/** Poll an ongoing update: server restart severs persistent connections, while polling naturally survives. */
export function useUpdateStatus(enabled: boolean) {
  return useQuery({
    queryKey: UPDATE_KEY,
    queryFn: () => api.get<UpdateStatus>('/api/system/update/status'),
    enabled,
    refetchInterval: 1000,
    // Requests fail during restart: keep the latest known state visible instead of showing an error.
    retry: false,
    placeholderData: (previous) => previous,
  })
}
