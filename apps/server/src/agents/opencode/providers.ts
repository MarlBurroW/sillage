import { homedir } from 'node:os'
import type { OpencodeConnectionDto, OpencodeProviderDto } from '@sillage/protocol'
import { withProbeServer } from './probe.js'
import type { OpencodeServer } from './server.js'
import { readFilled } from './v2/catalog.js'

/**
 * Model providers of OpenCode 2, connected and disconnected through a disposable server, like the
 * catalogs. OpenCode stores the credentials in its own database for the machine's user; Sillage
 * relays a typed key once and reads back only names and IDs. `GET /api/credential` returns keys in
 * clear text (probed 2.4.2), so it is never read: the integration list already names each saved
 * credential.
 */

interface Integration {
  id: string
  name: string
  methods: { type: string }[]
  connections: ({ type: 'credential'; id: string; label: string; method: 'key' | 'oauth' | 'external' } | { type: 'env'; name: string })[]
}

export class OpencodeProvidersUnsupported extends Error {
  constructor() {
    super('Connecting providers from Sillage needs OpenCode 2.')
  }
}

export class OpencodeProviders {
  constructor(
    private readonly executable: () => Promise<string>,
    /** A connection changes which models exist: the catalogs read them again. */
    private readonly changed: () => void,
  ) {}

  /** Connected providers first, then by name. */
  list(): Promise<OpencodeProviderDto[]> {
    return this.with(async (server) => {
      const integrations = await loaded(server)
      return integrations.map(toProvider).sort((a, b) =>
        Number(b.connections.length > 0) - Number(a.connections.length > 0) || a.name.localeCompare(b.name))
    })
  }

  async connectKey(providerId: string, key: string, label?: string): Promise<void> {
    await this.with(async (server) => {
      // A fresh server knows no integration until the list has loaded: "Integration not found"
      // otherwise (probed 2.4.2).
      await loaded(server)
      await server.post(`/api/integration/${encodeURIComponent(providerId)}/connect/key`, { key, ...(label ? { label } : {}) })
    })
    this.changed()
  }

  async disconnect(credentialId: string): Promise<void> {
    await this.with((server) => server.request('DELETE', `/api/credential/${encodeURIComponent(credentialId)}`))
    this.changed()
  }

  private async with<T>(read: (server: OpencodeServer) => Promise<T>): Promise<T> {
    return withProbeServer(await this.executable(), homedir(), (server, generation) => {
      if (generation !== 2) throw new OpencodeProvidersUnsupported()
      return read(server)
    })
  }
}

/** Like every 2.x list, the first read starts a lazy load and may come back empty. */
const loaded = (server: OpencodeServer) => readFilled<Integration>(server, '/api/integration')

function toProvider(integration: Integration): OpencodeProviderDto {
  return {
    id: integration.id,
    name: integration.name,
    acceptsKey: integration.methods.some((method) => method.type === 'key'),
    connections: integration.connections.map((connection): OpencodeConnectionDto =>
      connection.type === 'env'
        ? { type: 'env', name: connection.name }
        : { type: 'credential', id: connection.id, label: connection.label, method: connection.method }),
  }
}
