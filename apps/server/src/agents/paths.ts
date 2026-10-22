import { isAbsolute, relative, resolve } from 'node:path'

/** Working-directory-relative paths when inside it. External paths stay absolute: shortening would misrepresent targets and explorers cannot display them anyway. */
export function toWorkspacePath(cwd: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  const inside = relative(cwd, absolute)
  return inside.startsWith('..') || isAbsolute(inside) ? absolute : inside
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
