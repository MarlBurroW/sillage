import { existsSync } from 'node:fs'
import type { UpdateChannel } from '@sillage/protocol'

/**
 * L'unité systemd générée par install.sh pose SILLAGE_INSTALL_DIR, l'image
 * Docker pose SILLAGE_UPDATE_CHANNEL=docker. Le test /.dockerenv couvre une
 * image dérivée qui aurait perdu la variable. Tout le reste (checkout de dev,
 * layout inconnu) ne doit jamais permettre de mise à jour intégrée : on
 * écraserait des fichiers qu'on ne gère pas.
 */
export function detectChannel(): UpdateChannel {
  if (process.env.SILLAGE_UPDATE_CHANNEL === 'docker' || existsSync('/.dockerenv')) {
    return 'docker'
  }
  if (process.env.SILLAGE_INSTALL_DIR) return 'installer'
  return 'none'
}

/** Racine du layout installeur (contient releases/ et le lien current). */
export function installDir(): string {
  const dir = process.env.SILLAGE_INSTALL_DIR
  if (!dir) throw new Error('SILLAGE_INSTALL_DIR non défini')
  return dir
}
