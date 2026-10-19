import { linkSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'

/**
 * Pose en `link` un lien vers `target` : symbolique, ou ce qui en tient lieu sous Windows.
 *
 * Windows ne laisse créer un lien symbolique qu'en mode développeur ou en administrateur.
 * Un dossier y devient une jonction, qui ne demande aucun droit ; un fichier, un lien
 * symbolique quand c'est permis, sinon un lien physique (même volume), qui partage le
 * contenu du fichier mais pas son remplacement par un nouveau.
 */
export function linkTo(target: string, link: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return symlinkSync(target, link)
  if (statSync(target).isDirectory()) return symlinkSync(target, link, 'junction')
  try {
    symlinkSync(target, link, 'file')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
    linkSync(target, link)
  }
}

/**
 * Vrai quand le lien `link` mène à `target`. Une jonction rend sa cible en chemin absolu,
 * parfois préfixé de `\\?\` : on compare des chemins résolus.
 */
export function linksTo(link: string, target: string): boolean {
  const current = readlinkSync(link).replace(/^\\\\\?\\/, '')
  return path.resolve(path.dirname(link), current) === path.resolve(target)
}
