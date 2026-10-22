/**
 * Push notifications. Loaded with `importScripts` into the Workbox-generated service worker, adding
 * listeners while retaining generated precaching rather than maintaining the entire worker
 * manually. This script has no session and cannot refetch: every displayed value comes from the
 * server push payload.
 */

/**
 * Notification titles by kind in the device language: the server does not know UI language and this
 * script cannot access its catalog. Keep server-provided titles as fallback.
 */
const TITLES = {
  fr: {
    permission: 'Une autorisation est demandée',
    question: "L'agent te demande de choisir",
    elicitation: 'Un service demande une saisie',
    plan: 'Un plan attend ta validation',
    turnCompleted: "L'agent a terminé",
    decision: 'Décision à prendre',
    test: 'Notification de test',
  },
  en: {
    permission: 'Approval requested',
    question: 'The agent is asking you to choose',
    elicitation: 'A service is asking for input',
    plan: 'A plan is waiting for approval',
    turnCompleted: 'The agent has finished',
    decision: 'Decision to make',
    test: 'Test notification',
  },
}

function titleOf(payload) {
  const language = (self.navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en'
  return (payload.kind && TITLES[language][payload.kind]) || payload.title
}

function bodyOf(payload) {
  if (payload.kind !== 'test') return payload.body
  const french = (self.navigator.language || 'en').toLowerCase().startsWith('fr')
  return french ? 'Les notifications de Sillage arrivent bien sur cet appareil.' : 'Sillage notifications reach this device.'
}

self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    // Unreadable payload: show nothing instead of an empty notification, but swallow errors or the
    // browser disables the subscription.
    return
  }

  // Pending decision count on the installed app icon; no effect where the API is unavailable.
  if (typeof payload.badge === 'number' && self.navigator.setAppBadge) {
    self.navigator.setAppBadge(payload.badge).catch(() => {})
  }

  event.waitUntil(
    self.registration.showNotification(titleOf(payload), {
      body: bodyOf(payload),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Keep one displayed notification per conversation using the server-supplied tag.
      tag: payload.tag,
      renotify: true,
      data: { url: payload.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url
  if (!url) return

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

      // Reuse an existing app tab instead of opening a second view of the same conversation.
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        if ('navigate' in client) await client.navigate(url)
        return
      }

      await self.clients.openWindow(url)
    })(),
  )
})
