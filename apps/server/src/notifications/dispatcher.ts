import type { Db } from '@sillage/db'
import type { InAppNotification, NotificationKind, PushPayload } from '@sillage/protocol'
import type { PushService } from '../push/push-service.js'
import { readUserSettings } from '../settings/user-settings.js'

/**
 * Ce que le hub WebSocket sait des onglets ouverts, et lui seul : lesquels sont
 * visibles, ce qu'ils regardent, et à quel abonnement push correspond leur appareil.
 */
export interface Presence {
  /** Abonnements push des appareils où l'application est visible, pour ce compte. */
  visibleEndpoints(userId: string): Set<string>
  /** Un onglet visible de ce compte a cette conversation sous les yeux. */
  watchesVisibly(conversationId: string, userId: string): boolean
  /** Un toast pour chaque onglet visible de ce compte. */
  toast(userId: string, notification: InAppNotification): void
  /** Les décisions de ce compte ont changé : ses onglets relisent la liste. */
  decisionsChanged(userId: string): void
}

export interface OutgoingNotification {
  kind: NotificationKind
  push: PushPayload
  /** Absent : pas de toast, seulement la notification système (une fin de tour). */
  toast?: InAppNotification
  /** La conversation concernée : si elle est sous les yeux, rien ne part. */
  conversationId?: string
}

/**
 * Aiguille une notification : toast sur l'appareil où l'application est visible,
 * notification système sur les autres, jamais les deux au même endroit, et rien du
 * tout si la conversation est déjà regardée. Le compte peut couper chaque sorte.
 *
 * Le tri se fait ici et pas dans le service worker : Safari exige que chaque push
 * affiche une notification, et retire l'abonnement d'une application qui en escamote.
 */
export class Notifications {
  private presence: Presence | null = null

  constructor(
    private readonly db: Db,
    private readonly push: PushService,
  ) {}

  setPresence(presence: Presence): void {
    this.presence = presence
  }

  decisionsChanged(userId: string): void {
    this.presence?.decisionsChanged(userId)
  }

  async dispatch(userId: string, notification: OutgoingNotification): Promise<void> {
    if (!readUserSettings(this.db, userId).notifications[notification.kind]) return
    const presence = this.presence
    if (notification.conversationId && presence?.watchesVisibly(notification.conversationId, userId)) return
    if (notification.toast) presence?.toast(userId, notification.toast)
    await this.push.notify(userId, notification.push, { except: presence?.visibleEndpoints(userId) })
  }
}
