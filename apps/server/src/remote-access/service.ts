import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '@sillage/db'
import { REMOTE_ACCESS_HTTPS_PORT, type RemoteAccessState } from '@sillage/protocol'
import { HttpError } from '../http/errors.js'
import type { RemoteAccessGate } from '../http/local-origin.js'
import { readRemoteAccess, writeRemoteAccess, type RemoteAccessSettings } from '../settings/app-settings.js'
import type { TailscaleCli } from './tailscale.js'

/**
 * Remote access to a desktop instance.
 *
 * The server keeps listening on 127.0.0.1; Tailscale Serve forwards an HTTPS port of the
 * machine's tailnet address to it. Enabling records the hostname and tailnet login the
 * local-origin guard must accept, then configures Serve. The two are deliberately separate:
 * when the CLI refuses (Linux without the operator flag, HTTPS disabled on the tailnet), the
 * acceptance stays recorded and the user runs the printed command instead.
 *
 * Settings are cached in memory for the guard, which runs on every request; this service is
 * their only writer.
 */
export class RemoteAccessService implements RemoteAccessGate {
  private settings: RemoteAccessSettings
  private port = 0
  private serveError: string | null = null

  constructor(
    private readonly db: Db,
    private readonly cli: TailscaleCli,
    private readonly log: FastifyBaseLogger,
  ) {
    this.settings = readRemoteAccess(db)
  }

  allowed(): { hostname: string; login: string } | null {
    const { enabled, hostname, login } = this.settings
    return enabled && hostname && login ? { hostname, login } : null
  }

  /**
   * Called once the server listens: Serve must point at this launch's port. The desktop app
   * keeps it stable, but a port taken by another program moves it, and the recorded mapping
   * would otherwise forward to the wrong place.
   */
  async listening(port: number): Promise<void> {
    this.port = port
    if (!this.allowed()) return
    try {
      const mapping = await this.cli.serveStatus(REMOTE_ACCESS_HTTPS_PORT)
      if (mapping?.target === port) return
      await this.cli.serve(REMOTE_ACCESS_HTTPS_PORT, port)
      this.serveError = null
      this.log.info({ port }, 'tailscale serve mapping restored')
    } catch (err) {
      this.serveError = err instanceof Error ? err.message : String(err)
      this.log.warn({ err }, 'tailscale serve mapping could not be restored')
    }
  }

  async state(): Promise<RemoteAccessState> {
    const tailscale = await this.cli.status()
    let serve: RemoteAccessState['serve'] = { target: null, funnel: false }
    if (tailscale.state === 'running') {
      try {
        serve = (await this.cli.serveStatus(REMOTE_ACCESS_HTTPS_PORT)) ?? serve
      } catch (err) {
        this.log.warn({ err }, 'tailscale serve status unreadable')
      }
    }
    const { enabled, hostname, login } = this.settings
    return {
      enabled,
      port: this.port,
      hostname: enabled ? hostname : null,
      login: enabled ? login : null,
      url: enabled && hostname ? `https://${hostname}` : null,
      tailscale,
      serve,
      serveError: enabled ? this.serveError : null,
    }
  }

  async enable(): Promise<RemoteAccessState> {
    const tailscale = await this.cli.status()
    if (tailscale.state !== 'running') {
      throw new HttpError(409, 'tailscale_not_running', 'Tailscale is not connected on this machine.')
    }
    if (!tailscale.login) {
      throw new HttpError(409, 'tailscale_tagged_node', 'This machine is a tagged Tailscale node: no account can be recognised.')
    }
    if (!tailscale.https) {
      throw new HttpError(409, 'tailscale_https_disabled', 'HTTPS certificates are disabled on this tailnet.')
    }
    this.save({ enabled: true, hostname: tailscale.hostname, login: tailscale.login })
    try {
      await this.cli.serve(REMOTE_ACCESS_HTTPS_PORT, this.port)
      this.serveError = null
    } catch (err) {
      this.serveError = err instanceof Error ? err.message : String(err)
      this.log.warn({ err }, 'tailscale serve refused; the user runs the command by hand')
    }
    return this.state()
  }

  async disable(): Promise<RemoteAccessState> {
    // Remove the Serve mapping only when it is ours: another program on 443 keeps it.
    try {
      const mapping = await this.cli.serveStatus(REMOTE_ACCESS_HTTPS_PORT)
      if (mapping && (mapping.target === this.port || mapping.target === null)) {
        await this.cli.serveOff(REMOTE_ACCESS_HTTPS_PORT)
      }
    } catch (err) {
      this.log.warn({ err }, 'tailscale serve mapping could not be removed')
    }
    this.save({ enabled: false, hostname: null, login: null })
    this.serveError = null
    return this.state()
  }

  private save(settings: RemoteAccessSettings): void {
    writeRemoteAccess(this.db, settings)
    this.settings = settings
  }
}
