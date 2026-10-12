/**
 * Notifications push.
 *
 * Chargé par `importScripts` dans le service worker généré par Workbox : garder la
 * génération automatique du précache tout en ajoutant nos propres écouteurs, plutôt
 * que d'écrire le service worker entier à la main.
 *
 * Ce script n'a pas de session et ne peut rien aller relire : tout ce qu'il affiche
 * vient du contenu poussé par le serveur.
 */

/**
 * Titres par sorte de notification, dans la langue de l'appareil : le serveur ne connaît
 * pas celle de l'interface, et ce script n'a pas accès à son catalogue. Le titre envoyé
 * par le serveur reste le repli.
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
    // Contenu illisible : mieux vaut ne rien afficher qu'une notification vide, mais
    // l'erreur ne doit pas remonter, sinon le navigateur désactive l'abonnement.
    return
  }

  // Le nombre de décisions en attente sur l'icône de l'application installée ; sans
  // effet là où l'API n'existe pas.
  if (typeof payload.badge === 'number' && self.navigator.setAppBadge) {
    self.navigator.setAppBadge(payload.badge).catch(() => {})
  }

  event.waitUntil(
    self.registration.showNotification(titleOf(payload), {
      body: bodyOf(payload),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Une conversation ne garde qu'une notification affichée : le serveur envoie son
      // identifiant comme étiquette.
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

      // Un onglet déjà ouvert sur l'application est réutilisé : en ouvrir un second
      // laisserait deux vues de la même conversation côte à côte.
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
