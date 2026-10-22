import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { McpServer, McpServerListDto, McpTransport } from '@sillage/protocol'
import { api } from './api'

/**
 * Instance-wide MCP server registry. Everyone can read so composers can offer servers for
 * conversations to enable. Only administrators can write, enforced server-side: declaring an MCP
 * server describes a command CLIs execute as the server's system user.
 */

const MCP_KEY = ['mcp', 'servers']

export function useMcpServers() {
  return useQuery({
    queryKey: MCP_KEY,
    queryFn: () => api.get<McpServerListDto>('/api/mcp/servers'),
    staleTime: 60_000,
  })
}

export interface McpServerInput {
  name: string
  enabled: boolean
  transport: McpTransport
}

export function useCreateMcpServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: McpServerInput) => api.post<McpServer>('/api/mcp/servers', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MCP_KEY }),
  })
}

export function useUpdateMcpServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<McpServerInput>) =>
      api.patch<McpServer>(`/api/mcp/servers/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MCP_KEY }),
  })
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/mcp/servers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MCP_KEY }),
  })
}

/**
 * Readable transport summary for the server list. Commands and URLs distinguish servers at a glance
 * better than names. Omit environment variables because they contain secrets and do not belong in
 * list rows.
 */
export function describeTransport(transport: McpTransport): string {
  return transport.type === 'stdio'
    ? [transport.command, ...transport.args].join(' ')
    : transport.url
}
