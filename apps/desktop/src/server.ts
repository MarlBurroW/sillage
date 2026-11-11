import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'

export interface ServerOptions {
  /** Bundled Node, under which the runtime was installed and verified. */
  node: string
  /** Release runtime tree: `server/`, `web/`, `node_modules/`. */
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
  /** Remote access through Tailscale Serve is on: other devices may connect at any time. */
  remoteAccess: boolean
}

/**
 * Why the server did not come up. An early exit often has a passing cause (the port or
 * the database still held by a previous run), unlike a Node that cannot be started.
 */
export class ServerStartError extends Error {
  constructor(
    readonly reason: 'spawn' | 'exit' | 'timeout',
    /** What the reason leaves out: the system's error, the exit code or signal, the time waited. */
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`)
  }
}

export interface RunningServer {
  readonly pid: number | undefined
  /** Resolves when the server responds and the user's session is open. */
  ready: Promise<Handshake>
  onExit(listener: (code: number | null) => void): void
  stop(): Promise<void>
}

/** Beyond this size, start a fresh log and keep the old one alongside it. */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024
/** Old database migrations take seconds, not two minutes. */
const READY_TIMEOUT_MS = 120_000
/** Time to clean up active sessions, as when stopping a server service. */
const STOP_TIMEOUT_MS = 15_000
/** After the kill, how long to wait for the exit event before moving on without it. */
const KILL_GRACE_MS = 2_000

/**
 * Start Sillage's release server with installed-service settings
 * (`deploy/sillage.plist.tmpl`) plus the desktop profile.
 *
 * The server announces its port and user session on descriptor 3, a dedicated pipe
 * (`apps/server/src/instance/desktop.ts`): the session travels through neither the
 * network nor logs, which receive stdout/stderr. Its stdin is a pipe the app closes
 * to request shutdown, on Windows and elsewhere.
 *
 * `windowsHide` gives the server a hidden console instead of a window: spawned git
 * and CLI processes inherit it rather than opening individual windows.
 */
export function startServer(options: ServerOptions): RunningServer {
  mkdirSync(dirname(options.logFile), { recursive: true })
  mkdirSync(options.dataDir, { recursive: true })
  rotate(options.logFile)
  const log = openSync(options.logFile, 'a')
  // Let Node size its heap for the machine; 256 MiB can fail while loading user data.
  const child = spawn(options.node, [join(options.runtime, 'server', 'main.js')], {
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
    stdio: ['pipe', log, log, 'pipe'],
    windowsHide: true,
  })
  // The server has its own descriptor copy; retaining ours would only leak it.
  closeSync(log)

  let exited = false
  child.once('exit', () => {
    exited = true
  })
  // A Node that cannot be spawned (missing after an interrupted update, or blocked)
  // reports `error` and never `exit`: there is nothing to stop.
  child.once('error', () => {
    if (child.pid === undefined) exited = true
  })
  // Closing the pipe of a server that already died must not throw in the main process.
  child.stdin?.on('error', () => undefined)

  const ready = new Promise<Handshake>((resolve, reject) => {
    const channel = child.stdio[3] as Readable
    let buffer = ''
    const timer = setTimeout(() => {
      killTree(child.pid)
      reject(new ServerStartError('timeout', `${READY_TIMEOUT_MS / 1000} s`))
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
        const { port, session, remoteAccess } = JSON.parse(buffer.slice(0, end)) as { port: number; session: string; remoteAccess?: boolean }
        resolve({ origin: `http://127.0.0.1:${port}`, session, remoteAccess: remoteAccess === true })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    child.once('error', (err) => fail(new ServerStartError('spawn', err.message)))
    child.once('exit', (code, signal) => fail(new ServerStartError('exit', signal ?? `code ${code}`)))
  })
  // Rejection after resolution (a later normal shutdown) must not report anything.
  ready.catch(() => {})

  return {
    pid: child.pid,
    ready,
    onExit(listener) {
      child.on('exit', (code) => listener(code))
    },
    stop() {
      if (exited) return Promise.resolve()
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          killTree(child.pid)
          // Quitting and updating wait on this promise: never leave them pending on an
          // exit event that does not come.
          setTimeout(resolve, KILL_GRACE_MS)
        }, STOP_TIMEOUT_MS)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.stdin?.end()
      })
    },
  }
}

/**
 * Last resort when the server could not stop: Windows `taskkill /T` also kills
 * the CLIs it spawned, which nothing else would stop.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    process.kill(pid, 'SIGKILL')
  }
}

function rotate(file: string): void {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // No log yet: nothing to rotate.
  }
}
