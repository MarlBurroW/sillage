// Instance versioning and updates.

/**
 * How this installation updates:
 * - `installer`: installer layout (releases/ + `current` link); built-in updates available to
 * administrators.
 * - `docker`: immutable image; only show the new version and command to run.
 * - `desktop`: desktop app replaced by its new version; the server does nothing itself.
 * - `none`: development checkout or unknown layout; no update offered.
 */
export type UpdateChannel = 'installer' | 'docker' | 'desktop' | 'none'

export interface ReleaseNote {
  tag: string
  name: string
  publishedAt: string
  /** GitHub release notes in Markdown (written in English). */
  body: string
  htmlUrl: string
}

export interface VersionInfo {
  /** Installed version (`X.Y.Z`, or git ID in development). */
  version: string
  channel: UpdateChannel
  latest: string | null
  updateAvailable: boolean
  /** Releases strictly newer than the installed version, newest first. */
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
  /** Progress lines, displayed verbatim. */
  log: string[]
  error: string | null
}
