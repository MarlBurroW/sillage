import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Chemin relatif au répertoire de travail quand il en fait partie.
 *
 * Un chemin hors workspace reste absolu : le raccourcir mentirait sur l'endroit
 * touché, et l'explorateur ne saurait de toute façon pas l'afficher.
 */
export function toWorkspacePath(cwd: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  const inside = relative(cwd, absolute)
  return inside.startsWith('..') || isAbsolute(inside) ? absolute : inside
}

/**
 * Forme comparable d'un chemin, pour dire si deux écritures désignent le même dossier.
 *
 * Le `cwd` qu'un CLI écrit dans ses transcripts dépend du terminal qui l'a lancé : sous
 * Windows, VS Code donne `c:\...` avec le lecteur en minuscule, cmd garde la casse tapée,
 * et notre sélecteur de dossier rend la casse réelle. Le système, lui, ignore la casse
 * (Windows et macOS) et confond les deux séparateurs (Windows) : comparer à l'octet
 * près écartait des sessions pourtant reprenables.
 */
export function comparablePath(path: string, platform: NodeJS.Platform = process.platform): string {
  let out = platform === 'win32' ? path.replaceAll('\\', '/') : path
  if (platform === 'darwin') out = out.normalize('NFC')
  // Le `/` final ne distingue rien, sauf la racine (`/` ou `C:/`), qu'on garde entière.
  out = out.replace(/(?<=[^/:])\/+$/, '')
  return platform === 'win32' || platform === 'darwin' ? out.toLowerCase() : out
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparablePath(a, platform) === comparablePath(b, platform)
}
