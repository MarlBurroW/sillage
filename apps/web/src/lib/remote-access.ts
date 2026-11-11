import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RemoteAccessState } from '@sillage/protocol'
import { api } from './api'

const KEY = ['remote-access']

/** Desktop remote access through Tailscale Serve; the route exists only on the desktop profile. */
export function useRemoteAccess(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<RemoteAccessState>('/api/remote-access'),
    enabled,
    // The Tailscale client connects and disconnects outside Sillage: follow it while the page is open.
    refetchInterval: 15_000,
  })
}

export function useSetRemoteAccess() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => api.post<RemoteAccessState>(`/api/remote-access/${enabled ? 'enable' : 'disable'}`, {}),
    onSuccess: (state) => {
      queryClient.setQueryData(KEY, state)
      // The app keeps the machine awake while devices may connect.
      window.sillageDesktop?.remoteAccess?.changed(state.enabled)
    },
  })
}
