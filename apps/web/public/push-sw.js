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

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
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
