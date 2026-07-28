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
