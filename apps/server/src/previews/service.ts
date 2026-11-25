import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { PREVIEW_HOST_PREFIX } from '@sillage/protocol'
import { previewShares, users, type Db } from '@sillage/db'
import { eq } from 'drizzle-orm'
import { previewTargets } from './targets.js'

export type PreviewShareRow = typeof previewShares.$inferSelect
import type { Config } from '../config.js'
import { previewDomainOf } from '../settings/app-settings.js'

/** The sign-in link only lives long enough to load the frame. */
const SIGN_IN_TTL_MS = 60_000
/** A viewer stays signed in to one preview for a working day. */
const COOKIE_TTL_MS = 12 * 60 * 60_000
const COOKIE = 'sillage_preview'
const SIGN_IN_PATH = '/__sillage/preview-sign-in'

export interface PreviewTarget {
  id: string
  port: number
  /** Who opened it: only they may sign in, the account's visibility being checked at that time. */
  userId: string
  /** A demo link: anyone with the address gets in, without signing in. */
  public?: boolean
}

/** Public links re-check that their port still belongs to their owner at most this often. */
const SHARE_CHECK_MS = 30_000

/**
 * Dev-server previews on Server: a loopback listener that a reverse proxy reaches for
 * `pv-<id>.<domain>` hosts. Separate from Sillage's own listener so the preview never shares its
 * origin, its cookies or its host guard, and so nothing of Sillage answers on preview hosts.
 */
export class PreviewService {
  private readonly targets = new Map<string, PreviewTarget>()
  /** Last check that a shared port still serves its owner's dev server. */
  private readonly shareChecks = new Map<string, { at: number; ok: boolean }>()
  private readonly key: Buffer
  private server: Server | null = null

  constructor(private readonly db: Db, private readonly config: Config) {
    this.key = loadKey(join(config.paths.data, 'previews', 'key'))
  }

  get listenerPort(): number {
    return this.config.previews.port || this.config.server.port + 1
  }

  domain(): string {
    return previewDomainOf(this.db, this.config)
  }

  /**
   * Stable per account and port, so reopening keeps the address (and its signed-in cookie). The
   * registry is in memory: after a restart the address answers "reopen from Sillage" until then.
   */
  /** `secure` follows the request that opens it: https behind a TLS proxy, http on a local test. */
  open(userId: string, port: number, secure = true): { address: string; url: string } {
    const id = createHmac('sha256', this.key).update(`${userId}:${port}`).digest('hex').slice(0, 12)
    this.targets.set(id, { id, port, userId })
    const address = `${secure ? 'https' : 'http'}://${PREVIEW_HOST_PREFIX}${id}.${this.domain()}/`
    const expires = Date.now() + SIGN_IN_TTL_MS
    const token = `${expires}.${this.sign(`sign-in:${id}:${expires}`)}`
    return { address, url: `${address.slice(0, -1)}${SIGN_IN_PATH}?t=${token}` }
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res))
    this.server.on('upgrade', (req, socket: Socket, head) => this.upgrade(req, socket, head))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.listenerPort, '127.0.0.1', () => resolve())
    })
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server?.closeAllConnections()
  }

  private sign(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('hex')
  }

  private verify(value: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(value))
    const given = Buffer.from(signature)
    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  /** Creates a public demo link; the caller has checked the port belongs to the account. */
  createShare(input: { userId: string; projectId: string | null; port: number; label: string; hours: number }): PreviewShareRow {
    const now = Date.now()
    const { hours, ...owner } = input
    // Longer than private ids, so the two never collide and the address resists guessing.
    const row: PreviewShareRow = { id: randomBytes(8).toString('hex'), ...owner, createdAt: now, expiresAt: now + hours * 3_600_000, revokedAt: null }
    this.db.insert(previewShares).values(row).run()
    return row
  }

  shareUrl(id: string, secure = true): string {
    return `${secure ? 'https' : 'http'}://${PREVIEW_HOST_PREFIX}${id}.${this.domain()}/`
  }

  /** Revoking takes effect at once: the next request is refused, open sockets are not cut. */
  revokeShare(id: string): void {
    this.db.update(previewShares).set({ revokedAt: Date.now() }).where(eq(previewShares.id, id)).run()
    this.shareChecks.delete(id)
  }

  /**
   * Target for a request's Host: a preview opened from Sillage, a public link, or a reason to
   * refuse. Public links stay valid only while the owner still sees the port in Services: a
   * stopped dev server does not hand its port to whatever listens there next.
   */
  private async targetOf(req: IncomingMessage): Promise<PreviewTarget | { refused: string } | null> {
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
    const suffix = `.${this.domain()}`
    if (!this.domain() || !host.startsWith(PREVIEW_HOST_PREFIX) || !host.endsWith(suffix)) return null
    const id = host.slice(PREVIEW_HOST_PREFIX.length, -suffix.length)
    const opened = this.targets.get(id)
    if (opened) return opened
    const share = this.db.select().from(previewShares).where(eq(previewShares.id, id)).get()
    if (!share) return null
    if (share.revokedAt !== null || share.expiresAt < Date.now()) return { refused: 'This demo link has expired.' }
    let check = this.shareChecks.get(id)
    if (!check || Date.now() - check.at > SHARE_CHECK_MS) {
      const owner = this.db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, share.userId)).get()
      const ports = owner ? await previewTargets({ db: this.db, config: this.config }, [this.config.server.port, this.listenerPort], share.userId, owner.isAdmin) : []
      check = { at: Date.now(), ok: ports.some((target) => target.port === share.port) }
      this.shareChecks.set(id, check)
    }
    if (!check.ok) return { refused: 'This demo is not running right now.' }
    return { id, port: share.port, userId: share.userId, public: true }
  }

  private signedIn(req: IncomingMessage, target: PreviewTarget): boolean {
    const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    const [expires, signature] = (cookie ?? '').split('.')
    return Boolean(expires && signature) && Number(expires) > Date.now() && this.verify(`cookie:${target.id}:${expires}`, signature!)
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    this.targetOf(req).then((target) => this.serve(req, res, target), () => notice(res, 502, 'The preview is unavailable.'))
  }

  private serve(req: IncomingMessage, res: ServerResponse, target: PreviewTarget | { refused: string } | null): void {
    if (!target) {
      notice(res, 404, 'This preview is no longer open. Open it again from Sillage.')
      return
    }
    if ('refused' in target) {
      notice(res, 410, target.refused)
      return
    }
    const url = new URL(req.url ?? '/', 'http://preview')
    if (url.pathname === SIGN_IN_PATH) {
      const [expires, signature] = (url.searchParams.get('t') ?? '').split('.')
      if (!expires || !signature || Number(expires) < Date.now() || !this.verify(`sign-in:${target.id}:${expires}`, signature)) {
        notice(res, 403, 'This preview link has expired. Open it again from Sillage.')
        return
      }
      const until = Date.now() + COOKIE_TTL_MS
      // Host-only, so no other subdomain sees it. Over https it is partitioned and cross-site: the
      // frame then works even when the preview domain is another site than Sillage's. Plain http
      // (local checks) cannot carry SameSite=None and falls back to Lax.
      const https = req.headers['x-forwarded-proto'] === 'https'
      const attributes = https ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax'
      res.setHeader('set-cookie', `${COOKIE}=${until}.${this.sign(`cookie:${target.id}:${until}`)}; Path=/; HttpOnly; ${attributes}; Max-Age=${COOKIE_TTL_MS / 1000}`)
      res.writeHead(302, { location: '/' })
      res.end()
      return
    }
    if (!target.public && !this.signedIn(req, target)) {
      notice(res, 401, 'Open this preview from Sillage to sign in to it.')
      return
    }
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, target),
    }, (reply) => {
      const headers = { ...reply.headers }
      // Demo links are shared by hand, never meant for search engines.
      if (target.public) headers['x-robots-tag'] = 'noindex, nofollow'
      // Absolute redirects to the loopback address the app believes it serves.
      if (typeof headers.location === 'string') headers.location = headers.location.replace(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+/i, '')
      res.writeHead(reply.statusCode ?? 502, headers)
      reply.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) notice(res, 502, `Nothing answers on port ${target.port} any more. Is the dev server still running?`)
      else res.destroy()
    })
    req.pipe(upstream)
  }

  /** WebSockets (hot reload) are piped as raw bytes once the upgrade request is rewritten. */
  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    this.targetOf(req).then((target) => this.pipeSocket(req, socket, head, target), () => socket.destroy())
  }

  private pipeSocket(req: IncomingMessage, socket: Socket, head: Buffer, target: PreviewTarget | { refused: string } | null): void {
    if (!target || 'refused' in target || (!target.public && !this.signedIn(req, target))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = connect(target.port, '127.0.0.1', () => {
      const headers = forwardHeaders(req, target)
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([name, value]) =>
        value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((entry) => `${name}: ${entry}`))]
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const end = () => { upstream.destroy(); socket.destroy() }
    upstream.on('error', end)
    socket.on('error', end)
    upstream.on('close', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  }
}

/**
 * The app sees a request to its own loopback address: dev servers accept `localhost` out of the
 * box (Vite's allowed hosts, Django's `ALLOWED_HOSTS` in debug), with no per-project
 * configuration. The original host stays in `X-Forwarded-Host` for apps that honor it, and the
 * preview's own cookie never reaches the app.
 */
function forwardHeaders(req: IncomingMessage, target: PreviewTarget): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers }
  headers['x-forwarded-host'] = req.headers.host
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? 'http'
  headers.host = `localhost:${target.port}`
  if (typeof headers.origin === 'string') headers.origin = `http://localhost:${target.port}`
  const cookies = (req.headers.cookie ?? '').split(/;\s*/).filter((part) => part && !part.startsWith(`${COOKIE}=`))
  if (cookies.length) headers.cookie = cookies.join('; ')
  else delete headers.cookie
  return headers
}

function notice(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sillage preview</title><body style="font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#555"><p>${message}</p>`)
}

function loadKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex')
    if (key.length === 32) return key
  }
  const key = randomBytes(32)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, key.toString('hex'), { mode: 0o600 })
  } catch {
    // Read-only data directory: addresses change at each restart, nothing else breaks.
  }
  return key
}
