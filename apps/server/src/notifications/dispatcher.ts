import type { Db } from '@sillage/db'
import type { InAppNotification, NotificationKind, PushPayload } from '@sillage/protocol'
import type { PushService } from '../push/push-service.js'
import { readUserSettings } from '../settings/user-settings.js'

/** Open-tab state known only by the WebSocket hub: visibility, viewed content and the push subscription corresponding to each device. */
export interface Presence {
  /** Push subscriptions for devices where this account's application is visible. */
  visibleEndpoints(userId: string): Set<string>
  /** A visible tab belonging to this account is viewing this conversation. */
  watchesVisibly(conversationId: string, userId: string): boolean
  /** One toast per visible tab belonging to this account. */
  toast(userId: string, notification: InAppNotification): void
  /** This account's decisions changed: its tabs reload the list. */
  decisionsChanged(userId: string): void
}

export interface OutgoingNotification {
  kind: NotificationKind
  push: PushPayload
  /** Absent: no toast, only a system notification (turn completion). */
  toast?: InAppNotification
  /** Target conversation: suppress notifications when it is already being viewed. */
  conversationId?: string
}

/** Routes notifications: toast on devices with the app visible, system notification on others, never both on the same device, and nothing when the conversation is being viewed. Accounts may disable each kind. Filter here rather than in the service worker: Safari requires every push to display a notification and unsubscribes apps that suppress them. */
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
