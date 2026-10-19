import { spawnSync } from 'node:child_process'

/**
 * Arrête un processus et ceux qu'il a lancés.
 *
 * Sous Linux et macOS, par son groupe : le processus doit avoir été lancé `detached`,
 * chef de son propre groupe. Sous Windows, il n'y a pas de groupe à viser, et un lancement
 * détaché ouvrirait une console à part : `taskkill /T` parcourt l'arborescence, et ne
 * connaît qu'une manière, définitive, d'arrêter.
 */
export function killTree(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    // Déjà terminé.
  }
}
