/**
 * Serveur MCP réduit au strict nécessaire, pour la sonde `mcp-probe.ts`.
 *
 * Aucun réseau ni dépendance : s'il n'apparaît pas dans l'inventaire d'un CLI, la cause
 * est dans le chemin que Sillage sonde, pas dans l'installation d'un paquet.
 */
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
        // On renvoie la version demandée par le client : le CLI décide, pas nous.
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

  // Les notifications n'ont pas d'id et n'attendent pas de réponse.
  if (msg.id === undefined) return

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `inconnu: ${msg.method}` } })
})
