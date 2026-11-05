import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AnswerMcpInstallBody,
  McpServer,
  McpServerListDto,
  McpTransport,
} from '@sillage/protocol'
import { api } from './api'

/**
 * MCP server registry: global servers and each project's. Everyone reads what they can see so
 * composers can offer it. Writes follow the scope rule, enforced server-side: administrators for
 * global servers, the project owner for a project's.
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
  /** Null or absent for a global server. Set at creation only: a server does not change scope. */
  projectId?: string | null
}

/**
 * Registry entries a conversation of `projectId` can receive: global ones and its own
 * project's. Mirrors the server-side resolution, so the composer never offers a server the CLI
 * would not get.
 */
export function serversForProject(servers: McpServer[], projectId: string | null | undefined): McpServer[] {
  return servers.filter((server) => server.projectId === null || server.projectId === projectId)
}

/** Answers an agent's installation proposal shown in a conversation. */
export function answerMcpInstall(
  conversationId: string,
  requestId: string,
  body: AnswerMcpInstallBody,
): Promise<{ server: McpServer | null }> {
  return api.post(`/api/conversations/${conversationId}/mcp-installs/${requestId}`, body)
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

/** Lets a surface outside the hooks above (the installation prompt) refresh the registry. */
export function useInvalidateMcpServers() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: MCP_KEY })
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
