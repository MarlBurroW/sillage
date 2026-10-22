import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import webpush from 'web-push'
import { pushSubscriptions, type Db } from '@sillage/db'
import { randomUUID } from 'node:crypto'
import type { PushDeliveryDto, PushDeviceDto, PushPayload, PushServiceKind, PushTestDto } from '@sillage/protocol'

/** Web Push notifications. The server needs no third-party account: VAPID authenticates directly with browser push services without Google or Apple accounts. Instance-specific key pairs are generated on first startup. Notify only what users cannot see: agents requesting decisions or turns ending while attention is elsewhere. Notifying everything would mean nobody reads anything. */

const KEYS_FILE = 'vapid.json'

/** Fallback VAPID subject. The protocol requires a `mailto:` or URL where push services can contact the operator. Google does not validate it; Apple rejects `localhost` (403 BadJwtToken). Subscriptions therefore retain their public instance address; this fallback serves only older entries. */
const FALLBACK_SUBJECT = 'mailto:sillage@localhost'

/** Subject to retain for a subscription address: an HTTPS origin, never local. */
export function vapidSubject(origin: string | null | undefined): string | null {
  if (!origin) return null
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || /^(localhost|127\.|\[::1\])/.test(url.hostname) || url.hostname.endsWith('.local')) return null
    return url.origin
  } catch {
    return null
  }
}

/** Subscription service inferred from its address, identifying the device type. */
export function pushServiceOf(endpoint: string): PushServiceKind {
  const host = (() => {
    try {
      return new URL(endpoint).hostname
    } catch {
      return ''
    }
  })()
  if (host.endsWith('push.apple.com')) return 'apple'
  if (host.endsWith('googleapis.com')) return 'google'
  if (host.endsWith('mozilla.com') || host.endsWith('mozaws.net')) return 'mozilla'
  if (host.endsWith('notify.windows.com')) return 'microsoft'
  return 'other'
}

/** Trials retained in memory while the test screen reads their results. */
const TEST_RETENTION_MS = 10 * 60_000

interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** Reads the instance key pair, creating it on first startup. */
function loadOrCreateKeys(dataDir: string): VapidKeys {
  const path = join(dataDir, KEYS_FILE)

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VapidKeys>
    if (parsed.publicKey && parsed.privateKey) {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
    }
  } catch (err) {
    // Missing files are normal on first startup. Existing unreadable files must surface:
    // silently regenerating keys would break all existing subscriptions
    // without explanation.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Clés VAPID illisibles (${path}) : ${(err as Error).message}`)
    }
  }

  const generated = webpush.generateVAPIDKeys()
  writeFileSync(path, JSON.stringify(generated, null, 2), { mode: 0o600 })
  return generated
}

/** Logging interface needed by this service without depending on Fastify. */
interface Logger {
  warn: (obj: unknown, message: string) => void
}

export class PushService {
  readonly publicKey: string
  /** Fallback logger until the application's logger exists: the application is built after this injected service. Writing stderr is better than swallowing delivery failures. */
  private log: Logger = {
    warn: (obj, message) => process.stderr.write(`[push] ${message} ${JSON.stringify(obj)}\n`),
  }

  private readonly keys: VapidKeys
  private readonly tests = new Map<string, PushTestDto & { userId: string }>()

  constructor(
    private readonly db: Db,
    dataDir: string,
    /** Configured public instance address, preferred as subject when HTTPS. */
    private readonly publicUrl = '',
  ) {
    this.keys = loadOrCreateKeys(dataDir)
    this.publicKey = this.keys.publicKey
  }

  setLogger(log: Logger): void {
    this.log = log
  }

  subscribe(
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent: string | undefined,
    /** Subscribing page origin: public instance address as seen by the browser. */
    origin?: string,
  ): void {
    const subject = vapidSubject(origin)
    // A device resubscribing after key rotation must replace its entry rather than
    // create a duplicate that fails on every delivery.
    this.db
      .insert(pushSubscriptions)
      .values({
        endpoint: subscription.endpoint,
        userId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: userAgent ?? null,
        createdAt: Date.now(),
        subject,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          createdAt: Date.now(),
          subject,
        },
      })
      .run()
  }

  unsubscribe(endpoint: string): void {
    this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run()
  }

  /** Account's subscribed devices for notification settings. */
  devices(userId: string): PushDeviceDto[] {
    return this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all()
      .map((row) => ({ endpoint: row.endpoint, service: pushServiceOf(row.endpoint), userAgent: row.userAgent, createdAt: row.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Remove a device belonging to this account only. */
  removeDevice(userId: string, endpoint: string): boolean {
    const row = this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get()
    if (!row || row.userId !== userId) return false
    this.unsubscribe(endpoint)
    return true
  }

  /** Test notification to all account devices after a server-held delay, allowing users to close the app and see it on a locked phone. Per-device results remain readable for a few minutes. */
  scheduleTest(userId: string, delaySeconds: number): PushTestDto {
    const test = { id: randomUUID(), userId, sendAt: Date.now() + delaySeconds * 1000, deliveries: null as PushDeliveryDto[] | null }
    this.tests.set(test.id, test)
    const timer = setTimeout(() => {
      void this.notify(userId, { title: 'Sillage', body: 'Notification test', url: '/settings/notifications', tag: `test-${test.id}`, kind: 'test' })
        .then((deliveries) => { test.deliveries = deliveries })
      const cleanup = setTimeout(() => this.tests.delete(test.id), TEST_RETENTION_MS)
      cleanup.unref()
    }, delaySeconds * 1000)
    timer.unref()
    return this.testView(test)
  }

  test(userId: string, id: string): PushTestDto | null {
    const test = this.tests.get(id)
    return test && test.userId === userId ? this.testView(test) : null
  }

  private testView(test: PushTestDto & { userId: string }): PushTestDto {
    return { id: test.id, sendAt: test.sendAt, deliveries: test.deliveries }
  }

  /** Whether this account has at least one subscribed device. */
  hasSubscriptions(userId: string): boolean {
    const row = this.db
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .get()
    return row !== undefined
  }

  /** Notifies every account device. Do not propagate failures: lost notifications must never interrupt agents (invariant I1). Delete subscriptions reported dead to avoid accumulating stale endpoints retried on every send. */
  async notify(userId: string, payload: PushPayload, options: { except?: Set<string> } = {}): Promise<PushDeliveryDto[]> {
    const rows = this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all()
      // Devices already displaying the app received a toast instead.
      .filter((row) => !options.except?.has(row.endpoint))

    return Promise.all(
      rows.map(async (row): Promise<PushDeliveryDto> => {
        const service = pushServiceOf(row.endpoint)
        try {
          await webpush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            JSON.stringify(payload),
            {
              TTL: 600,
              vapidDetails: {
                subject: row.subject ?? vapidSubject(this.publicUrl) ?? FALLBACK_SUBJECT,
                publicKey: this.keys.publicKey,
                privateKey: this.keys.privateKey,
              },
            },
          )
          return { endpoint: row.endpoint, service, outcome: 'sent', status: null, reason: null }
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode ?? null
          const reason = pushFailureReason(err)
          // 404 and 410 mean browser-revoked subscriptions. Other errors may be transient,
          // so retain those subscriptions.
          if (status === 404 || status === 410) {
            this.unsubscribe(row.endpoint)
            return { endpoint: row.endpoint, service, outcome: 'removed', status, reason }
          }
          // Messages matter as much as status: unreachable endpoints and rejected
          // content require different diagnoses.
          this.log.warn({ status, endpoint: row.endpoint, cause: reason }, 'notification push non delivree')
          return { endpoint: row.endpoint, service, outcome: 'failed', status, reason }
        }
      }),
    )
  }
}

/** Rejection reason: Apple returns `{"reason":"BadJwtToken"}`, others return text. */
function pushFailureReason(err: unknown): string {
  const body = (err as { body?: unknown }).body
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body) as { reason?: unknown }
      if (typeof parsed.reason === 'string') return parsed.reason
    } catch {
      // Not JSON: return bounded raw text.
    }
    return body.trim().slice(0, 200)
  }
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
}
