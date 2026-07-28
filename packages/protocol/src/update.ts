// Versionnage et mise à jour de l'instance.

/**
 * Comment cette installation se met à jour :
 * - `installer` : layout de l'installeur (releases/ + lien `current`), la mise à
 *   jour intégrée est disponible pour un administrateur.
 * - `docker` : l'image est immuable, on affiche seulement la nouvelle version et
 *   la commande à lancer.
 * - `none` : checkout de dev ou layout inconnu, pas de mise à jour proposée.
 */
export type UpdateChannel = 'installer' | 'docker' | 'none'

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
