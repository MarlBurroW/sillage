// How the instance is deployed and what that deployment supports.

/**
 * - `server`: server daemon (installer, Docker, development checkout), accessed through a
 * browser, often from another machine.
 * - `desktop`: launched by the desktop app on its sole user's workstation and displayed in its
 * window.
 */
export type InstanceProfile = 'server' | 'desktop'

/**
 * Deployment capabilities derived server-side from the profile.
 *
 * Screens check capabilities, never profiles, just as they check `AgentCapabilities` instead of
 * CLI names: future variants (such as a desktop window connected to a remote server) inherit
 * correct behavior by declaring their capabilities.
 */
export interface InstanceCapabilities {
  /**
   * Password accounts: login, logout, password changes and user management. Absent on Desktop,
   * where the launcher opens the sole user's session itself.
   */
  passwordAuth: boolean
  /** Web Push notifications to the user's devices. */
  webPush: boolean
  /**
   * Installable web app: service worker, offline caching and reload prompts when a version is
   * deployed. On Desktop, the app delivers updates; a cache would merely serve the old version.
   */
  pwa: boolean
  /**
   * Projects shared between accounts: private/shared choice at creation and in project
   * settings. Irrelevant on Desktop with its single account: the question has no useful answer,
   * and a lock on a project nobody else can see conveys nothing.
   */
  sharedProjects: boolean
}

export interface InstanceInfo {
  profile: InstanceProfile
  capabilities: InstanceCapabilities
  /**
   * True while the database has no account: the UI opens first-account onboarding instead of
   * login. Always false on Desktop, where the launcher creates the account.
   */
  needsSetup: boolean
  /** Machine name, telling the user where Sillage just started. */
  hostname: string
  /** Home directory of the system account running Sillage, where projects can be stored. */
  homeDir: string
}
