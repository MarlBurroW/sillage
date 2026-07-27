import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import webpush from 'web-push'
import { pushSubscriptions, type Db } from '@sillage/db'
import type { PushPayload } from '@sillage/protocol'

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
 * Sujet VAPID. Le protocole exige un `mailto:` ou une URL par lequel le service de push
 * peut joindre l'opérateur ; il n'est jamais résolu, et une instance auto-hébergée n'a
 * pas d'adresse publique à donner.
 */
const VAPID_SUBJECT = 'mailto:sillage@localhost'

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

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    const keys = loadOrCreateKeys(dataDir)
    this.publicKey = keys.publicKey
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey)
  }

  setLogger(log: Logger): void {
    this.log = log
  }

  subscribe(
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent: string | undefined,
  ): void {
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
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          createdAt: Date.now(),
        },
      })
      .run()
  }

  unsubscribe(endpoint: string): void {
    this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run()
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
  async notify(userId: string, payload: PushPayload): Promise<void> {
    const rows = this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all()

    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            JSON.stringify(payload),
            { TTL: 600 },
          )
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          // 404 et 410 : le navigateur a révoqué l'abonnement. Toute autre erreur peut
          // être passagère, l'abonnement est conservé.
          if (status === 404 || status === 410) {
            this.unsubscribe(row.endpoint)
            return
          }
          // Le message compte autant que le code : un endpoint injoignable et un
          // contenu refusé ne se diagnostiquent pas de la même façon.
          this.log.warn(
            {
              status,
              endpoint: row.endpoint,
              cause: err instanceof Error ? err.message : String(err),
            },
            'notification push non delivree',
          )
        }
      }),
    )
  }
}
