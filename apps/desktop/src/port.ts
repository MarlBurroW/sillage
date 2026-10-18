import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'

/**
 * Le port du serveur local, choisi une fois et gardé dans les réglages de l'app.
 *
 * L'origine de la page (`http://127.0.0.1:<port>`) porte le stockage local du navigateur :
 * brouillons, préférences d'affichage, panneaux ouverts. Un port tiré à chaque lancement
 * les ferait repartir de zéro. Il n'est remplacé que s'il est pris, par un autre
 * programme ou par une installation serveur de Sillage sur le même poste.
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
