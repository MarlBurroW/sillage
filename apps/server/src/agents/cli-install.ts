import { installAntigravity } from './antigravity/install.js'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import {
  PREFERRED_CLI_RELEASES,
  type AgentKind,
  type CliInstallStateDto,
} from '@sillage/protocol'
import { resolveBinary } from './cli-binary.js'
import { launchOf } from './launch.js'

/**
 * Sillage-managed agent CLI installation.
 *
 * Binaries no longer ship in releases, so fresh servers may have none. Rather than require
 * terminals unavailable in Docker/remote use, install target versions into owned npm prefix.
 *
 * Background job, not HTTP request: packages weigh hundreds of MB and finishing within request
 * lifetime would be luck. State is queryable, not returned synchronously.
 */

/** Timeout after which installation is considered lost rather than slow. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/** Failure stderr retained: enough for diagnosis, bounded so verbose npm cannot fill daemon memory. */
const MAX_ERROR_CHARS = 4_000

/**
 * Registry request as npm http logs it: `npm http fetch GET 200
 * https://registry.npmjs.org/…/claude-code-2.1.301.tgz 1532ms`. Only nonterminal sign of life:
 * progress requires TTY, default logging silent until final report.
 */
const FETCH_LINE = /^npm (?:http|verb http) fetch \w+ \d+ (\S+)/
/** Error lines in npm 10 (npm error) and npm 9 (npm ERR!) formats. */
const ERROR_LINE = /^npm (?:error|ERR!)\b/

type State =
  | { status: 'idle' }
  | { status: 'running'; version: string; startedAt: number; fetched: number; current: string | null }
  | { status: 'failed'; version: string; error: string; at: number }

export class CliInstaller {
  /** Per-agent state. Absence means never attempted, exposed as idle by state(). */
  private readonly states = new Map<AgentKind, State>()

  constructor(
    private readonly prefix: string,
    /**
     * Notify after CLI install. Presence probe is cached: without invalidation screen would revert
     * to Install until expiry, appearing ineffective.
     */
    private readonly onInstalled: (kind: AgentKind) => void = () => {},
  ) {}

  state(kind: AgentKind): CliInstallStateDto {
    const state = this.states.get(kind) ?? { status: 'idle' }
    return state.status === 'failed'
      ? { status: 'failed', version: state.version, error: state.error }
      : state.status === 'running'
        ? {
            status: 'running',
            version: state.version,
            startedAt: state.startedAt,
            fetched: state.fetched,
            current: state.current,
          }
        : { status: 'idle' }
  }

  /**
   * Start installation and return immediately.
   *
   * False if this CLI already installing: concurrent npm installs in same prefix interfere, with no
   * guarantee which version survives.
   */
  start(kind: AgentKind): boolean {
    if (this.states.get(kind)?.status === 'running') return false

    const { package: pkg, version } = PREFERRED_CLI_RELEASES[kind]
    this.states.set(kind, { status: 'running', version, startedAt: Date.now(), fetched: 0, current: null })
    void this.run(kind, pkg, version)
    return true
  }

  private async run(kind: AgentKind, pkg: string, version: string): Promise<void> {
    try {
      // npm refuses nonexistent prefixes. Create here, not startup: directory needed only when
      // installing.
      await mkdir(this.prefix, { recursive: true })
      if (kind === 'antigravity') await installAntigravity(this.prefix, version, (message) => this.progress(kind, message))
      else await this.npm(kind, pkg, version)
      this.onInstalled(kind)
      this.states.set(kind, { status: 'idle' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.states.set(kind, {
        status: 'failed',
        version,
        error: message.slice(0, MAX_ERROR_CHARS),
        at: Date.now(),
      })
    }
  }

  /** Record another registry request so interface shows progress. */
  private progress(kind: AgentKind, url: string): void {
    const state = this.states.get(kind)
    if (state?.status !== 'running') return
    // Filename suffices: full registry URL adds nothing and does not fit interface line.
    const current = url.slice(url.lastIndexOf('/') + 1) || null
    this.states.set(kind, { ...state, fetched: state.fetched + 1, current })
  }

  private npm(kind: AgentKind, pkg: string, version: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use --prefix instead of user npm config: install in Sillage storage without moving system
      // packages. --no-fund/--no-audit suppress unread output. --loglevel=http reports downloads
      // during installation minutes. Resolve npm like CLI: Windows npm.cmd cannot launch directly
      // through Node without shell. Desktop bundles fallback last on PATH.
      const npm = resolveBinary('npm')
      if (!npm) {
        reject(new Error("npm est introuvable sur le serveur : impossible d'installer un CLI."))
        return
      }
      const launch = launchOf(npm)
      const child = spawn(
        launch.command,
        [
          ...launch.args,
          'install',
          '-g',
          '--prefix',
          this.prefix,
          '--no-fund',
          '--no-audit',
          '--no-progress',
          '--loglevel=http',
          `${pkg}@${version}`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: INSTALL_TIMEOUT_MS, windowsHide: true },
      )

      // Keep error lines only: request logs matter during installation, and hundreds of package
      // files would exceed retention cap.
      const errors: string[] = []
      let pending = ''
      let errorChars = 0
      const onLine = (line: string) => {
        const fetch = FETCH_LINE.exec(line)
        if (fetch?.[1]) {
          this.progress(kind, fetch[1])
        } else if (ERROR_LINE.test(line) && errorChars < MAX_ERROR_CHARS) {
          errors.push(line)
          errorChars += line.length + 1
        }
      }
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })

      child.on('error', (err) =>
        reject(
          // Missing npm is likely on minimal servers; “spawn npm ENOENT” does not explain to
          // web-interface users.
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? new Error("npm est introuvable sur le serveur : impossible d'installer un CLI.")
            : err,
        ),
      )
      child.on('close', (code, signal) => {
        if (pending) onLine(pending)
        if (code === 0) return resolve()
        // npm stderr explains network/permissions/unknown-version failures; exit code alone says
        // only exited with 1.
        reject(
          new Error(
            errors.join('\n') ||
              (signal ? `npm interrompu par ${signal}` : `npm a échoué (code ${code ?? '?'})`),
          ),
        )
      })
    })
  }
}
