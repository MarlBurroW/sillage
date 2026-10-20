// Versionnage et mise à jour de l'instance.

/**
 * Comment cette installation se met à jour :
 * - `installer` : layout de l'installeur (releases/ + lien `current`), la mise à
 *   jour intégrée est disponible pour un administrateur.
 * - `docker` : l'image est immuable, on affiche seulement la nouvelle version et
 *   la commande à lancer.
 * - `desktop` : l'application de bureau, qui se remplace elle-même par sa nouvelle
 *   version (`DesktopUpdateState`) ; le serveur n'a rien à faire lui-même.
 * - `none` : checkout de dev ou layout inconnu, pas de mise à jour proposée.
 */
export type UpdateChannel = 'installer' | 'docker' | 'desktop' | 'none'

export interface ReleaseNote {
  tag: string
  name: string
  publishedAt: string
  /** Markdown des notes de release GitHub (rédigées en anglais). */
  body: string
  htmlUrl: string
}

export interface VersionInfo {
  /** Version installée (`X.Y.Z`, ou identifiant git en dev). */
  version: string
  channel: UpdateChannel
  latest: string | null
  updateAvailable: boolean
  /** Releases strictement plus récentes que la version installée, la plus récente d'abord. */
  releases: ReleaseNote[]
  checkedAt: string | null
  checkError: 'rate_limited' | 'network' | null
}

export type UpdatePhase =
  | 'idle'
  | 'downloading'
  | 'extracting'
  | 'switching'
  | 'restarting'
  | 'failed'

export interface UpdateStatus {
  phase: UpdatePhase
  targetVersion: string | null
  startedAt: string | null
  /** Lignes de progression, à afficher telles quelles. */
  log: string[]
  error: string | null
}

/**
 * La mise à jour de l'application de bureau. Son processus principal la mène
 * (apps/desktop/src/updates.ts), pas le serveur qu'elle embarque : c'est l'app entière,
 * Electron et Node compris, qui change de version. La fenêtre la suit par le pont
 * `window.sillageDesktop`.
 *
 * Elle part toute seule : l'app cherche au lancement puis toutes les quatre heures,
 * télécharge ce qu'elle trouve, et l'installe à la fermeture, ou tout de suite si
 * l'utilisateur redémarre l'app pour ça.
 */
export type DesktopUpdateState =
  | { status: 'unsupported'; reason: DesktopUpdateUnsupportedReason }
  | { status: 'idle'; checkedAt: string | null }
  | { status: 'checking' }
  | { status: 'downloading'; version: string; percent: number }
  /**
   * Téléchargée et vérifiée. `installOnQuit` est faux quand l'installation demande le mot
   * de passe de l'administrateur (le paquet .deb) : on ne le réclame pas à la fermeture.
   */
  | { status: 'ready'; version: string; installOnQuit: boolean }
  | { status: 'installing'; version: string }
  /**
   * `macPermission` : macOS a refusé à Sillage de remplacer sa propre app, ce que règle
   * l'autorisation « Gestion des apps » de la confidentialité.
   */
  | { status: 'error'; message: string; version: string | null; macPermission: boolean }

/**
 * Pourquoi l'app ne peut pas se mettre à jour seule :
 * - `development` : lancée depuis le dépôt, ou build de CI sans numéro de version publié ;
 * - `package` : un format que l'app ne sait pas remplacer (dossier décompressé, snap…) ;
 * - `location` : sous macOS, l'app tourne d'un endroit où elle ne peut pas s'écrire
 *   (l'image disque, ou une copie isolée par Gatekeeper hors du dossier Applications).
 */
export type DesktopUpdateUnsupportedReason = 'development' | 'package' | 'location'

/** Ce que le preload de l'app de bureau expose à la fenêtre, sous `window.sillageDesktop`. */
export interface DesktopBridge {
  updates: {
    state(): Promise<DesktopUpdateState>
    /** Rend de quoi se désabonner. */
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
    check(): Promise<void>
    /** Ferme l'app, installe la version téléchargée et relance l'app. */
    install(): Promise<void>
  }
}
