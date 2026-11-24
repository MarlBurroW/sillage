import { OpencodeServer } from './server.js'
import { opencodeGeneration, type OpencodeGeneration } from './version-guard.js'

/**
 * Start opencode serve for catalog/directory commands/fork reading. No stream or injection: probe
 * sees actual machine configuration. `read` learns which server generation answers, since routes
 * differ between majors.
 */
export async function withProbeServer<T>(
  binary: string,
  cwd: string,
  read: (server: OpencodeServer, generation: OpencodeGeneration) => Promise<T>,
): Promise<T> {
  const generation = await opencodeGeneration(binary)
  // Keep self-update disabled: probes must not change binary. Each major names the switch its way.
  const config = generation === 2 ? { update: 'disable' } : { autoupdate: false }
  const server = await OpencodeServer.start({ binary, cwd, generation, config })
  try {
    return await read(server, generation)
  } finally {
    server.close()
  }
}
