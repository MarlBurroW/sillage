/**
 * Les canaux entre le processus principal et le preload. Dans un module à part : le
 * preload n'embarque qu'eux, et non electron-updater avec le reste de `updates.ts`.
 */
export const UPDATE_CHANNELS = {
  state: 'sillage:updates:state',
  check: 'sillage:updates:check',
  install: 'sillage:updates:install',
  changed: 'sillage:updates:changed',
} as const
