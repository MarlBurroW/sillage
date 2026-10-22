import { once } from 'node:events'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { HttpError } from './http/errors.js'
import { refuseGitInternals, resolveRealInside } from './workspace.js'

/** Explorer selection as `.zip`: one directory or multiple entries. Browsers download one file per gesture; several consecutive downloads trigger confusing permission requests. Combining selections into archives matches other web explorers. */

/** Archive limits. The second also reflects fflate lacking zip64: offsets no longer fit beyond 4 GB. */
const MAX_ARCHIVE_FILES = 20_000
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024

/** Store already-compressed formats unchanged: recompression costs server CPU without saving bytes. */
const STORED = new Set([
  '7z', 'avif', 'br', 'bz2', 'gif', 'gz', 'jpeg', 'jpg', 'mkv', 'mov', 'mp3', 'mp4',
  'ogg', 'png', 'rar', 'tgz', 'webm', 'webp', 'woff', 'woff2', 'xz', 'zip', 'zst',
])

interface ArchiveItem {
  /** Archive name relative to the selection's common directory. */
  name: string
  absolute: string
  isDirectory: boolean
  mtime: Date
}

export interface Archive {
  filename: string
  items: ArchiveItem[]
}

/** Excludes entries already included by selected parent directories, avoiding duplicate files when selecting both a directory and one of its children. */
function pruneNested(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort()
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)),
  )
}

/** Deepest directory containing all entries; empty at root. */
function commonParent(paths: string[]): string {
  const parents = paths.map((path) => path.split('/').slice(0, -1))
  const first = parents[0] ?? []
  let depth = 0
  while (depth < first.length && parents.every((parts) => parts[depth] === first[depth])) {
    depth += 1
  }
  return first.slice(0, depth).join('/')
}

/** Inventory before writing any bytes: excess sizes must return readable errors rather than interrupt started downloads. Paths start at the selection's common directory so same-named `src` folders from different packages retain distinguishing paths; a lone folder retains its name. Skip `.git` and symlinks like tree browsing. */
export async function collectArchive(root: string, requested: string[]): Promise<Archive> {
  const paths = pruneNested(requested)
  const base = commonParent(paths)
  const items: ArchiveItem[] = []
  let files = 0
  let bytes = 0

  const tooLarge = (): never => {
    throw new HttpError(
      413,
      'archive_too_large',
      'Too much to download at once (maximum {maxFiles} files, {maxGb} GB).',
      { maxFiles: MAX_ARCHIVE_FILES, maxGb: MAX_ARCHIVE_BYTES / 1024 / 1024 / 1024 },
    )
  }

  const nameOf = (path: string) => (base ? path.slice(base.length + 1) : path)

  const visit = async (path: string, absolute: string): Promise<void> => {
    const info = await lstat(absolute).catch(() => null)
    if (!info) return

    if (info.isFile()) {
      files += 1
      bytes += info.size
      if (files > MAX_ARCHIVE_FILES || bytes > MAX_ARCHIVE_BYTES) tooLarge()
      items.push({ name: nameOf(path), absolute, isDirectory: false, mtime: info.mtime })
      return
    }
    if (!info.isDirectory()) return

    // Give directories their own entries: empty directories would otherwise disappear
    // from archives, changing the exported structure.
    items.push({ name: nameOf(path), absolute, isDirectory: true, mtime: info.mtime })
    const children = await readdir(absolute, { withFileTypes: true }).catch(() => [])
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === '.git' || !(child.isFile() || child.isDirectory())) continue
      await visit(`${path}/${child.name}`, `${absolute}/${child.name}`)
    }
  }

  for (const path of paths) {
    refuseGitInternals(path)
    await visit(path, await resolveRealInside(root, path))
  }

  const label = paths.length === 1 ? basename(paths[0] as string) : basename(base || root)
  return { filename: `${label || 'files'}.zip`, items }
}

/** ZIP timestamps only support 1980–2107 and fflate rejects rather than truncates them. Files dated 1970 (reproducible archives, Nix stores) would otherwise fail entire downloads. */
function zipDate(date: Date): Date {
  const year = date.getFullYear()
  if (year < 1980) return new Date(1980, 0, 1, 12)
  if (year > 2099) return new Date(2099, 11, 31, 12)
  return date
}

/** Streams archives one file at a time. Never assemble in memory; wait for clients to drain prior output because fflate lacks backpressure and slow downloads would otherwise accumulate the whole archive in the server heap. */
export function streamArchive(items: ArchiveItem[]): Readable {
  const out = new PassThrough()
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      out.destroy(err)
      return
    }
    out.write(chunk)
    if (final) out.end()
  })

  /** Waits for clients to resume or disconnect, since `drain` never arrives after disconnection. */
  const backpressure = async () => {
    if (out.writableNeedDrain) await Promise.race([once(out, 'drain'), once(out, 'close')])
  }

  const write = async () => {
    for (const item of items) {
      if (out.destroyed) return

      if (item.isDirectory) {
        const entry = new ZipPassThrough(`${item.name}/`)
        entry.mtime = zipDate(item.mtime)
        zip.add(entry)
        entry.push(new Uint8Array(0), true)
        continue
      }

      // Open before announcing entries: files disappearing after inventory are omitted
      // instead of leaving empty entries. Never follow symlinks or read named pipes
      // that could block awaiting writers.
      const handle = await open(
        item.absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch(() => null)
      if (!handle) continue
      if (!(await handle.stat()).isFile()) {
        await handle.close()
        continue
      }

      const entry = STORED.has(extname(item.name).slice(1).toLowerCase())
        ? new ZipPassThrough(item.name)
        : new ZipDeflate(item.name, { level: 6 })
      entry.mtime = zipDate(item.mtime)
      zip.add(entry)

      const stream = handle.createReadStream()
      for await (const chunk of stream) {
        entry.push(chunk as Buffer)
        await backpressure()
        if (out.destroyed) {
          stream.destroy()
          return
        }
      }
      entry.push(new Uint8Array(0), true)
    }
    zip.end()
  }

  void write().catch((err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))))
  return out
}
