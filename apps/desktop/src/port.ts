import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'

/**
 * Local server port, chosen once and kept in app settings.
 *
 * The page origin (`http://127.0.0.1:<port>`) owns browser local storage: drafts,
 * display preferences, open panels. Choosing a new port each launch would reset
 * them. Replace it only when occupied by another program or a Sillage server
 * installation on the same machine.
 */
export async function stablePort(file: string): Promise<number> {
  const saved = readSavedPort(file)
  if (saved !== null && (await isFree(saved))) return saved
  const port = await anyFreePort()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ port }, null, 2)}\n`)
  return port
}

function readSavedPort(file: string): number | null {
  try {
    const { port } = JSON.parse(readFileSync(file, 'utf8')) as { port?: unknown }
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function anyFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('aucun port libre'))))
    })
  })
}
