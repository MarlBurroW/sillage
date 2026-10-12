import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import webpush from 'web-push'
import { pushSubscriptions, type Db } from '@sillage/db'
import { randomUUID } from 'node:crypto'
import type { PushDeliveryDto, PushDeviceDto, PushPayload, PushServiceKind, PushTestDto } from '@sillage/protocol'

/**
 * Notifications Web Push.
 *
 * Le serveur ne connaît aucun tiers : le protocole VAPID lui permet de s'authentifier
 * directement auprès du service de push du navigateur, sans passer par un compte chez
 * Google ou Apple. La paire de clés est propre à l'instance et générée au premier
 * démarrage.
 *
 * Les notifications ne servent qu'à ce qu'on ne peut pas voir : un agent qui réclame
 * une décision, ou un tour terminé pendant qu'on regarde ailleurs. Tout notifier
 * reviendrait à n'être lu par personne.
 */

const KEYS_FILE = 'vapid.json'

/**
 * Sujet VAPID de repli. Le protocole exige un `mailto:` ou une URL par lequel le service
 * de push peut joindre l'opérateur. Google ne le vérifie pas, Apple si : il refuse un
 * sujet en `localhost` (403 BadJwtToken). Chaque abonnement garde donc l'adresse
 * publique par laquelle on a joint l'instance, et ce repli ne sert qu'aux anciens.
 */
const FALLBACK_SUBJECT = 'mailto:sillage@localhost'

/** Le sujet à retenir pour une adresse d'abonnement : une origine https, jamais locale. */
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

/** Le service d'un abonnement, lu dans son adresse : il dit de quel appareil il s'agit. */
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

/** Les essais gardés en mémoire, le temps que l'écran de test lise leur résultat. */
const TEST_RETENTION_MS = 10 * 60_000

interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** Lit la paire de clés de l'instance, en la créant au premier démarrage. */
function loadOrCreateKeys(dataDir: string): VapidKeys {
  const path = join(dataDir, KEYS_FILE)

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VapidKeys>
    if (parsed.publicKey && parsed.privateKey) {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
    }
  } catch (err) {
    // Absent au premier démarrage : c'est le cas normal. Un fichier présent mais
    // illisible doit en revanche se voir, sinon on régénère des clés en silence et
    // tous les abonnements existants cessent de fonctionner sans explication.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Clés VAPID illisibles (${path}) : ${(err as Error).message}`)
    }
  }

  const generated = webpush.generateVAPIDKeys()
  writeFileSync(path, JSON.stringify(generated, null, 2), { mode: 0o600 })
  return generated
}

/** Ce que le service attend d'un journal, sans dépendre de Fastify. */
interface Logger {
  warn: (obj: unknown, message: string) => void
}

export class PushService {
  readonly publicKey: string
  /**
   * Journal de repli tant que celui de l'application n'existe pas : il est construit
   * après le service, qui lui est passé en dépendance. Écrire sur la sortie d'erreur
   * vaut mieux que d'avaler les échecs d'envoi.
   */
  private log: Logger = {
    warn: (obj, message) => process.stderr.write(`[push] ${message} ${JSON.stringify(obj)}\n`),
  }

  private readonly keys: VapidKeys
  private readonly tests = new Map<string, PushTestDto & { userId: string }>()

  constructor(
    private readonly db: Db,
    dataDir: string,
    /** Adresse publique réglée pour l'instance, sujet préféré quand elle est en https. */
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
    /** Origine de la page qui s'abonne : l'adresse publique de l'instance, vue du navigateur. */
    origin?: string,
  ): void {
    const subject = vapidSubject(origin)
    // Le même appareil qui se réabonne après une rotation de clés doit remplacer son
    // entrée, pas en créer une seconde qui échouerait à chaque envoi.
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

  /** Les appareils abonnés d'un compte, pour l'écran des notifications. */
  devices(userId: string): PushDeviceDto[] {
    return this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all()
      .map((row) => ({ endpoint: row.endpoint, service: pushServiceOf(row.endpoint), userAgent: row.userAgent, createdAt: row.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Retire un appareil de ce compte, et seulement de lui. */
  removeDevice(userId: string, endpoint: string): boolean {
    const row = this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get()
    if (!row || row.userId !== userId) return false
    this.unsubscribe(endpoint)
    return true
  }

  /**
   * Une notification d'essai sur tous les appareils du compte, après un délai tenu par
   * le serveur : on a le temps de fermer l'application pour la voir arriver sur un
   * téléphone verrouillé. Le résultat de chaque envoi reste lisible quelques minutes.
   */
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

  /** Vrai si le compte a au moins un appareil abonné. */
  hasSubscriptions(userId: string): boolean {
    const row = this.db
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .get()
    return row !== undefined
  }

  /**
   * Adresse une notification à tous les appareils d'un compte.
   *
   * Les échecs ne remontent pas : une notification perdue ne doit jamais interrompre
   * un agent (invariant I1). Un abonnement que le service déclare mort est en revanche
   * supprimé, sinon la table accumule des endpoints périmés interrogés à chaque envoi.
   */
  async notify(userId: string, payload: PushPayload, options: { except?: Set<string> } = {}): Promise<PushDeliveryDto[]> {
    const rows = this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all()
      // L'appareil où l'application est sous les yeux a reçu un toast à la place.
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
          // 404 et 410 : le navigateur a révoqué l'abonnement. Toute autre erreur peut
          // être passagère, l'abonnement est conservé.
          if (status === 404 || status === 410) {
            this.unsubscribe(row.endpoint)
            return { endpoint: row.endpoint, service, outcome: 'removed', status, reason }
          }
          // Le message compte autant que le code : un endpoint injoignable et un
          // contenu refusé ne se diagnostiquent pas de la même façon.
          this.log.warn({ status, endpoint: row.endpoint, cause: reason }, 'notification push non delivree')
          return { endpoint: row.endpoint, service, outcome: 'failed', status, reason }
        }
      }),
    )
  }
}

/** Le motif d'un refus : Apple répond `{"reason":"BadJwtToken"}`, les autres un texte. */
function pushFailureReason(err: unknown): string {
  const body = (err as { body?: unknown }).body
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body) as { reason?: unknown }
      if (typeof parsed.reason === 'string') return parsed.reason
    } catch {
      // Pas du JSON : le texte tel quel, borné.
    }
    return body.trim().slice(0, 200)
  }
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
}
