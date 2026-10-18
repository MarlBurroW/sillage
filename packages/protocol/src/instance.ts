// Comment l'instance est déployée, et ce que ce déploiement permet.

/**
 * - `server` : le daemon d'un serveur (installeur, Docker, checkout de dev), joint par un
 *   navigateur, souvent depuis une autre machine ;
 * - `desktop` : lancé par l'application de bureau sur le poste de son unique utilisateur,
 *   et affiché dans sa fenêtre.
 */
export type InstanceProfile = 'server' | 'desktop'

/**
 * Ce que le déploiement permet, déduit du profil par le serveur.
 *
 * Les écrans testent une capacité, jamais le profil, comme ils testent `AgentCapabilities`
 * plutôt que le nom d'un CLI : une prochaine variante (la fenêtre de bureau branchée sur
 * un serveur distant, par exemple) hérite du bon comportement en déclarant les siennes.
 */
export interface InstanceCapabilities {
  /**
   * Comptes à mot de passe : page de connexion, déconnexion, changement de mot de passe
   * et gestion des utilisateurs. Absents en bureau, où le lanceur ouvre lui-même la
   * session de l'unique utilisateur.
   */
  passwordAuth: boolean
  /** Notifications Web Push vers les appareils de l'utilisateur. */
  webPush: boolean
  /**
   * Application web installable : service worker, mise en cache hors ligne et invitation
   * à recharger quand une version est déployée. En bureau, c'est l'application qui
   * apporte la nouvelle version, et un cache ne ferait que servir l'ancienne.
   */
  pwa: boolean
}

export interface InstanceInfo {
  profile: InstanceProfile
  capabilities: InstanceCapabilities
}
