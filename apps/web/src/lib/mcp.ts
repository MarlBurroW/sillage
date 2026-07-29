import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { McpServer, McpServerListDto, McpTransport } from '@sillage/protocol'
import { api } from './api'

/**
 * Registre des serveurs MCP, partagé par toute l'instance.
 *
 * En lecture pour tout le monde, parce que le composeur doit pouvoir proposer les
 * serveurs qu'une conversation peut activer. En écriture pour les administrateurs
 * seuls, le serveur le fait respecter : déclarer un serveur MCP décrit une commande
 * que les CLI lanceront sous l'utilisateur système du serveur.
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
 * Résumé lisible d'un transport, pour la liste des serveurs.
 *
 * La commande et l'URL sont ce qui distingue deux serveurs au premier coup d'oeil, bien
 * plus que leur nom. Les variables d'environnement n'y figurent pas : elles portent des
 * secrets et n'ont rien à faire dans une ligne de liste.
 */
export function describeTransport(transport: McpTransport): string {
  return transport.type === 'stdio'
    ? [transport.command, ...transport.args].join(' ')
    : transport.url
}
