/**
 * Keep IPC names separate so the preload does not bundle electron-updater.
 */
export const UPDATE_CHANNELS = {
  state: 'sillage:updates:state',
  check: 'sillage:updates:check',
  install: 'sillage:updates:install',
  changed: 'sillage:updates:changed',
} as const
