import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { appSettings, users, type Db } from '@sillage/db'
import { claudeLoginExpiry, type ClaudeHostLoginDto } from '@sillage/protocol'
import type { FastifyBaseLogger } from 'fastify'
import { CachedProbe } from '../agents/cached-probe.js'
import { launchOf } from '../agents/launch.js'
import { agentProcessEnv } from '../agents/process-env.js'
import type { Notifications } from '../notifications/dispatcher.js'

const run = promisify(execFile)
const CACHE_MS = 5 * 60_000
const CHECK_MS = 60 * 60_000
const UNKNOWN = { state: 'unavailable', loginExpiresAt: null } as const

/** auth status reads the existing home in place; copying OAuth credentials can revoke the host's refresh token. */
async function readStatus(binary: string): Promise<string> {
  const launch = launchOf(binary)
  try {
    const { stdout } = await run(launch.command, [...launch.args, 'auth', 'status'], {
      env: agentProcessEnv(), timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true,
    })
    return stdout
  } catch (err) {
    // Logged-out status exits with 1 but still returns its JSON. Never expose raw
    // stdout/stderr: it can contain the account email or environment credentials.
    const stdout = (err as { stdout?: unknown }).stdout
    if (typeof stdout === 'string') return stdout
    return ''
  }
}

export function parseHostLogin(raw: string): Omit<ClaudeHostLoginDto, 'checkedAt'> {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value.loggedIn !== 'boolean') return UNKNOWN
    const date = value.authMethod === 'claude.ai' && typeof value.loginExpiresAt === 'string' ? Date.parse(value.loginExpiresAt) : NaN
    return {
      state: value.loggedIn ? 'connected' : 'disconnected',
      loginExpiresAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
    }
  } catch {
    return UNKNOWN
  }
}

/** One cheap CLI probe per cache window, including when no conversation is running. */
export class ClaudeHostStatus {
  private readonly cache: CachedProbe<Omit<ClaudeHostLoginDto, 'checkedAt'>>
  private timer: NodeJS.Timeout | null = null
  private checking: Promise<void> | null = null
  private stopped = false

  constructor(
    private readonly db: Db,
    binary: () => Promise<string>,
    private readonly notifications: Pick<Notifications, 'dispatch'>,
    probe: (binary: string) => Promise<string> = readStatus,
    private readonly enabled = true,
  ) {
    this.cache = new CachedProbe(CACHE_MS, async () => {
      if (!this.enabled) return UNKNOWN
      try { return parseHostLogin(await probe(await binary())) } catch { return UNKNOWN }
    })
  }

  async read(force = false): Promise<ClaudeHostLoginDto> {
    const { fetchedAt, ...state } = await this.cache.read(force)
    return { ...state, checkedAt: fetchedAt }
  }

  start(logger: FastifyBaseLogger): void {
    if (this.timer || !this.enabled) return
    this.stopped = false
    const tick = () => { this.check().catch(() => logger.warn('Could not deliver the Claude host sign-in warning.')) }
    this.timer = setInterval(tick, CHECK_MS)
    this.timer.unref()
    tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Persist each threshold announcement so daemon restarts do not repeat it. */
  async check(): Promise<void> {
    if (this.checking) return this.checking
    this.checking = this.announce().finally(() => { this.checking = null })
    return this.checking
  }

  private async announce(): Promise<void> {
    const status = await this.read()
    const severity = claudeLoginExpiry(status.loginExpiresAt)
    if (this.stopped || !severity || !status.loginExpiresAt) return
    const admins = this.db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).all()
    for (const admin of admins) {
      if (this.stopped) return
      const key = `claudeHostExpiryNotice:${admin.id}`
      const value = JSON.stringify({ expiresAt: status.loginExpiresAt, severity })
      if (this.db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value === value) continue
      await this.notifications.dispatch(admin.id, {
        kind: 'credentialExpiry',
        push: {
          kind: 'credentialExpiry', title: 'Claude sign-in needs attention',
          body: `The host sign-in expires around ${status.loginExpiresAt}. Review Claude accounts in Sillage.`,
          loginExpiresAt: status.loginExpiresAt, url: '/settings/comptes-claude', tag: 'claude-host-login',
        },
        toast: { kind: 'credentialExpiry', agent: 'claude', loginExpiresAt: status.loginExpiresAt },
      })
      if (this.stopped) return
      const updatedAt = Date.now()
      this.db.insert(appSettings).values({ key, value, updatedAt })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } }).run()
    }
  }
}
