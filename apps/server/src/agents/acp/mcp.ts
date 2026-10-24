import type { McpServer } from '@sillage/protocol'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'

/** ACP registry server shape: environments and headers are pair lists rather than maps. */
export function toAcpMcpServer(server: McpServer): AcpMcpServer {
  const { transport } = server
  if (transport.type === 'stdio') {
    return {
      name: server.name,
      command: transport.command,
      args: transport.args,
      env: Object.entries(transport.env).map(([name, value]) => ({ name, value })),
    }
  }
  return {
    type: transport.type,
    name: server.name,
    url: transport.url,
    headers: Object.entries(transport.headers).map(([name, value]) => ({ name, value })),
  }
}
