import { existsSync } from 'node:fs'
import type { UpdateChannel } from '@sillage/protocol'
import { INSTANCE_PROFILE } from '../instance/profile.js'

/** install.sh systemd units set SILLAGE_INSTALL_DIR; Docker images set SILLAGE_UPDATE_CHANNEL=docker. Check /.dockerenv for derived images missing that variable. Never permit built-in updates for other layouts (development checkouts or unknown installations), which would overwrite unmanaged files. */
export function detectChannel(): UpdateChannel {
  // Desktop replaces the entire app with its new version; its bundled server
  // bundles never modifies its own files.
  if (INSTANCE_PROFILE === 'desktop') return 'desktop'
  if (process.env.SILLAGE_UPDATE_CHANNEL === 'docker' || existsSync('/.dockerenv')) {
    return 'docker'
  }
  if (process.env.SILLAGE_INSTALL_DIR) return 'installer'
  return 'none'
}

/** Installer layout root containing releases and the current symlink. */
export function installDir(): string {
  const dir = process.env.SILLAGE_INSTALL_DIR
  if (!dir) throw new Error('SILLAGE_INSTALL_DIR non défini')
  return dir
}
