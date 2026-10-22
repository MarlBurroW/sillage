import { useQuery } from '@tanstack/react-query'
import type { InstanceCapabilities, InstanceInfo } from '@sillage/protocol'
import { api } from './api'

/**
 * Instance profile: browser-accessed server or desktop app. Immutable during server lifetime, hence
 * infinite cache. `App` awaits it alongside session before rendering, avoiding unknown-profile
 * states and server-only actions briefly appearing in desktop windows.
 */
export function useInstance() {
  return useQuery({
    queryKey: ['system', 'instance'],
    queryFn: () => api.get<InstanceInfo>('/api/system/instance'),
    staleTime: Infinity,
    retry: false,
  })
}

/**
 * Instance capability: test this rather than profile; see `InstanceCapabilities`. Until profile
 * loads, or if loading fails, use server capabilities: this is the historical deployment and older
 * servers behind hot-deployed web clients lack this route.
 */
export function useCapability(name: keyof InstanceCapabilities): boolean {
  const { data } = useInstance()
  return data?.capabilities[name] ?? true
}
