import { linkSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'

/** Creates `link` pointing to `target` via symlinks or Windows equivalents. Windows requires developer mode or administrator rights for symlinks. Directories use unprivileged junctions; files use symlinks when permitted, otherwise same-volume hardlinks sharing contents but not replacement by new files. */
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

/** Whether `link` targets `target`. Junction targets are absolute, sometimes prefixed `\\?\`; compare resolved paths. */
export function linksTo(link: string, target: string): boolean {
  const current = readlinkSync(link).replace(/^\\\\\?\\/, '')
  return path.resolve(path.dirname(link), current) === path.resolve(target)
}
