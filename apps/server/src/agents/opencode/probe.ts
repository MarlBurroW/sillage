import { OpencodeServer } from './server.js'

/**
 * Start opencode serve for catalog/directory commands/fork reading. No stream or injection: probe
 * sees actual machine configuration.
 */
export async function withProbeServer<T>(
  binary: string,
  cwd: string,
  read: (server: OpencodeServer) => Promise<T>,
): Promise<T> {
  // Keep autoupdate disabled: probes must not change binary.
  const server = await OpencodeServer.start({ binary, cwd, config: { autoupdate: false } })
  try {
    return await read(server)
  } finally {
    server.close()
  }
}
