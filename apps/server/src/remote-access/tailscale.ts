import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TailscaleStatus } from '@sillage/protocol'

/**
 * The `tailscale` CLI, as far as Serve needs it. The machine's own Tailscale client does the
 * networking: Sillage only reads its status and asks Serve to forward an HTTPS port to the local
 * server, as the remote access guide has users do by hand.
 */
export interface TailscaleCli {
  status(): Promise<TailscaleStatus>
  /** Serve mapping on `httpsPort`, or null when the port is unmapped. */
  serveStatus(httpsPort: number): Promise<ServeMapping | null>
  /** `tailscale serve --bg --https=<httpsPort> <target>`; throws with the CLI's message on refusal. */
  serve(httpsPort: number, target: number): Promise<void>
  serveOff(httpsPort: number): Promise<void>
}

export interface ServeMapping {
  /** Local port behind the proxy, or null for a mapping that is not a plain port proxy. */
  target: number | null
  /** Funnel publishes the mapping to the Internet: the identity headers the guard needs are then absent. */
  funnel: boolean
}

const CLI_TIMEOUT_MS = 15_000

/**
 * Where the client installs its CLI when PATH does not carry it: the macOS app bundles it, the
 * Windows installer registers its own directory. Linux packages put it on PATH.
 */
function candidateBinaries(): string[] {
  const list = ['tailscale']
  if (process.platform === 'darwin') {
    list.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale')
  } else if (process.platform === 'win32') {
    const programs = process.env.ProgramFiles ?? 'C:\\Program Files'
    list.push(join(programs, 'Tailscale', 'tailscale.exe'))
  }
  return list
}

class CliError extends Error {
  constructor(message: string, readonly missing = false) {
    super(message)
  }
}

export class SystemTailscaleCli implements TailscaleCli {
  private binary: string | null = null

  async status(): Promise<TailscaleStatus> {
    try {
      return parseStatus(await this.run(['status', '--json']))
    } catch (err) {
      if (err instanceof CliError && err.missing) return { state: 'missing' }
      return { state: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  async serveStatus(httpsPort: number): Promise<ServeMapping | null> {
    return parseServeConfig(await this.run(['serve', 'status', '--json']), httpsPort)
  }

  async serve(httpsPort: number, target: number): Promise<void> {
    await this.run(['serve', '--bg', '--yes', `--https=${httpsPort}`, String(target)])
  }

  async serveOff(httpsPort: number): Promise<void> {
    await this.run(['serve', `--https=${httpsPort}`, 'off'])
  }

  private async run(args: string[]): Promise<string> {
    const binaries = this.binary ? [this.binary] : candidateBinaries()
    let lastError: CliError = new CliError('tailscale not found', true)
    for (const binary of binaries) {
      if (binary !== 'tailscale' && !existsSync(binary)) continue
      try {
        const output = await exec(binary, args)
        this.binary = binary
        return output
      } catch (err) {
        if (!(err instanceof CliError) || !err.missing) throw err
        lastError = err
      }
    }
    throw lastError
  }
}

function exec(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return reject(new CliError(`${binary}: not found`, true))
      // The CLI explains refusals on stderr: not logged in, Serve not permitted, HTTPS disabled.
      // It also suggests its own command to retry with; the page prints the one for this port.
      const detail = String(stderr || err.message).trim().split('\n').filter(Boolean).join(' ').split(" Use '")[0]
      reject(new CliError(detail || `tailscale ${args[0]} failed`))
    })
  })
}

/** `tailscale status --json`, keeping only what remote access decides on. */
export function parseStatus(json: string): TailscaleStatus {
  let raw: {
    BackendState?: string
    Self?: { DNSName?: string; UserID?: number; Tags?: string[] | null }
    User?: Record<string, { LoginName?: string }>
    CertDomains?: string[] | null
  }
  try {
    raw = JSON.parse(json)
  } catch {
    return { state: 'error', message: 'unreadable tailscale status' }
  }
  const backend = raw.BackendState ?? 'unknown'
  const hostname = raw.Self?.DNSName?.replace(/\.$/, '') ?? ''
  if (backend !== 'Running' || !hostname) return { state: 'stopped', backend }
  const tagged = Array.isArray(raw.Self?.Tags) && raw.Self.Tags.length > 0
  const login = tagged ? null : (raw.User?.[String(raw.Self?.UserID)]?.LoginName ?? null)
  return { state: 'running', hostname, login, https: (raw.CertDomains?.length ?? 0) > 0 }
}

/** `tailscale serve status --json` is the node's ServeConfig; read the handler at `/` for the port. */
export function parseServeConfig(json: string, httpsPort: number): ServeMapping | null {
  let raw: {
    TCP?: Record<string, { HTTPS?: boolean }>
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
    AllowFunnel?: Record<string, boolean> | null
  } | null
  try {
    raw = json.trim() ? JSON.parse(json) : null
  } catch {
    return null
  }
  if (!raw?.TCP?.[String(httpsPort)]?.HTTPS) return null
  const suffix = `:${httpsPort}`
  const site = Object.entries(raw.Web ?? {}).find(([key]) => key.endsWith(suffix))
  const proxy = site?.[1].Handlers?.['/']?.Proxy ?? ''
  const match = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy)
  return {
    target: match ? Number(match[1]) : null,
    funnel: site ? raw.AllowFunnel?.[site[0]] === true : false,
  }
}
