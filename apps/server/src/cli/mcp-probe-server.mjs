/** Minimal MCP server for `mcp-probe.ts`, without networking or dependencies. Missing CLI inventory entries therefore indicate probed integration paths rather than package installation problems. */
import { createInterface } from 'node:readline'

const log = (msg) => process.stderr.write(`[fake-mcp] ${msg}\n`)
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

const TOOLS = [
  {
    name: 'sillage_probe_echo',
    description: 'Renvoie le texte reçu. Sert uniquement à prouver que le serveur est chargé.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
]

log(`démarré, argv=${JSON.stringify(process.argv.slice(2))} PROBE_ENV=${process.env.PROBE_ENV ?? '<absent>'}`)

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  log(`<- ${msg.method ?? '(réponse)'}`)

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        // Echo client-requested versions: the CLI decides, not us.
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sillage-probe', version: '0.0.1' },
      },
    })
    return
  }

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    return
  }

  if (msg.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }] },
    })
    return
  }

  // Notifications have no IDs and expect no responses.
  if (msg.id === undefined) return

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `inconnu: ${msg.method}` } })
})
