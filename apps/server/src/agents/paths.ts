import { isAbsolute, relative, resolve } from 'node:path'

/** Working-directory-relative paths when inside it. External paths stay absolute: shortening would misrepresent targets and explorers cannot display them anyway. Relative paths always use `/`, as git and the interface do: on Windows `relative` returns backslashes, which then matched nothing git reported. */
export function toWorkspacePath(cwd: string, path: string, platform: NodeJS.Platform = process.platform): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  const inside = relative(cwd, absolute)
  return inside.startsWith('..') || isAbsolute(inside) ? absolute : toSlashPath(inside, platform)
}

/** Separators as git and URLs write them. Backslashes are separators only on Windows; elsewhere they are ordinary file-name characters and stay. */
export function toSlashPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/** Comparable path form identifying the same directory. Transcript cwd depends on launching terminals: Windows VS Code lowercases drives, cmd preserves input case, pickers return actual case. Windows/macOS ignore case and Windows treats separators alike; byte comparisons excluded resumable sessions. */
export function comparablePath(path: string, platform: NodeJS.Platform = process.platform): string {
  let out = platform === 'win32' ? path.replaceAll('\\', '/') : path
  if (platform === 'darwin') out = out.normalize('NFC')
  // Trailing `/` does not distinguish paths except roots (`/`, `C:/`), kept whole.
  out = out.replace(/(?<=[^/:])\/+$/, '')
  return platform === 'win32' || platform === 'darwin' ? out.toLowerCase() : out
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparablePath(a, platform) === comparablePath(b, platform)
}

/**
 * True when `child` is `parent` or lies inside it. Replaces `child.startsWith(parent + '/')`, which
 * never matched a Windows path (backslashes, any drive-letter case) and was case-sensitive on
 * macOS, where the file system is not.
 */
export function isUnder(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const base = comparablePath(parent, platform)
  const candidate = comparablePath(child, platform)
  return candidate === base || candidate.startsWith(base.endsWith('/') ? base : `${base}/`)
}
