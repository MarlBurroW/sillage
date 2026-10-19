import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'

export interface ServerOptions {
  /** Le Node embarqué, celui sous lequel l'arbre d'exécution a été installé et vérifié. */
  node: string
  /** L'arbre d'exécution de la release : `server/`, `web/`, `node_modules/`. */
  runtime: string
  dataDir: string
  configFile: string
  logFile: string
  port: number
  env: NodeJS.ProcessEnv
}

export interface Handshake {
  origin: string
  session: string
}

export interface RunningServer {
  /** Se résout quand le serveur répond et que la session de l'utilisateur est ouverte. */
  ready: Promise<Handshake>
  onExit(listener: (code: number | null) => void): void
  stop(): Promise<void>
}

/** Au-delà, le journal repart d'un fichier neuf, l'ancien gardé à côté. */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024
/** Les migrations d'une base ancienne prennent quelques secondes, pas deux minutes. */
const READY_TIMEOUT_MS = 120_000
/** Le temps de ranger les sessions en cours, comme à l'arrêt du service d'un serveur. */
const STOP_TIMEOUT_MS = 15_000

/**
 * Lance le serveur de Sillage tel que la release le livre, avec les réglages qu'une
 * installation pose dans son service (`deploy/sillage.plist.tmpl`), plus le profil de
 * bureau.
 *
 * Le serveur annonce son port et la session de l'utilisateur sur le descripteur 3, un
 * tube réservé à cet échange (`apps/server/src/instance/desktop.ts`) : la session ne
 * passe ni par le réseau ni par le journal, où vont stdout et stderr.
 */
export function startServer(options: ServerOptions): RunningServer {
  mkdirSync(dirname(options.logFile), { recursive: true })
  mkdirSync(options.dataDir, { recursive: true })
  rotate(options.logFile)
  const log = openSync(options.logFile, 'a')
  const child = spawn(options.node, ['--max-old-space-size=256', join(options.runtime, 'server', 'main.js')], {
    cwd: options.runtime,
    env: {
      ...options.env,
      NODE_ENV: 'production',
      SILLAGE_PROFILE: 'desktop',
      SILLAGE_HANDSHAKE_FD: '3',
      SILLAGE_DATA_DIR: options.dataDir,
      SILLAGE_CONFIG: options.configFile,
      SILLAGE_WEB_ROOT: join(options.runtime, 'web'),
      SILLAGE_HOST: '127.0.0.1',
      SILLAGE_PORT: String(options.port),
    },
    stdio: ['ignore', log, log, 'pipe'],
  })
  // Le serveur a sa propre copie du descripteur ; la nôtre ne servirait qu'à fuir.
  closeSync(log)

  let exited = false
  child.once('exit', () => {
    exited = true
  })

  const ready = new Promise<Handshake>((resolve, reject) => {
    const channel = child.stdio[3] as Readable
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`le serveur n'a pas répondu en ${READY_TIMEOUT_MS / 1000} s`))
    }, READY_TIMEOUT_MS)
    const fail = (err: Error) => {
      clearTimeout(timer)
      reject(err)
    }
    channel.setEncoding('utf8')
    channel.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end === -1) return
      clearTimeout(timer)
      try {
        const { port, session } = JSON.parse(buffer.slice(0, end)) as { port: number; session: string }
        resolve({ origin: `http://127.0.0.1:${port}`, session })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    child.once('error', fail)
    child.once('exit', (code, signal) => fail(new Error(`le serveur s'est arrêté au démarrage (${signal ?? `code ${code}`})`)))
  })
  // Un rejet après la résolution (l'arrêt normal, plus tard) ne doit rien signaler.
  ready.catch(() => {})

  return {
    ready,
    onExit(listener) {
      child.on('exit', (code) => listener(code))
    },
    stop() {
      if (exited) return Promise.resolve()
      return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.kill('SIGTERM')
      })
    },
  }
}

function rotate(file: string): void {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // Pas encore de journal : rien à faire tourner.
  }
}
