import { once } from 'node:events'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { HttpError } from './http/errors.js'
import { refuseGitInternals, resolveRealInside } from './workspace.js'

/**
 * Archive `.zip` d'une sélection de l'explorateur : un dossier, ou plusieurs entrées.
 *
 * Le navigateur ne sait télécharger qu'un fichier par geste, et en déclencher plusieurs
 * d'affilée lui fait demander une autorisation que personne ne comprend. Réunir la
 * sélection dans une archive est ce que fait tout explorateur web.
 */

/**
 * Plafonds d'une archive. Le second tient aussi à fflate, qui n'écrit pas le format
 * zip64 : au-delà de 4 Go, les décalages de l'archive ne tiennent plus.
 */
const MAX_ARCHIVE_FILES = 20_000
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Formats déjà compressés, rangés tels quels : les recompresser coûte du processeur au
 * serveur sans faire gagner un octet.
 */
const STORED = new Set([
  '7z', 'avif', 'br', 'bz2', 'gif', 'gz', 'jpeg', 'jpg', 'mkv', 'mov', 'mp3', 'mp4',
  'ogg', 'png', 'rar', 'tgz', 'webm', 'webp', 'woff', 'woff2', 'xz', 'zip', 'zst',
])

interface ArchiveItem {
  /** Nom dans l'archive, relatif au dossier commun de la sélection. */
  name: string
  absolute: string
  isDirectory: boolean
  mtime: Date
}

export interface Archive {
  filename: string
  items: ArchiveItem[]
}

/**
 * Retire les entrées déjà comprises dans un dossier sélectionné : sans ça, choisir un
 * dossier et l'un de ses fichiers mettrait ce fichier deux fois dans l'archive.
 */
function pruneNested(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort()
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)),
  )
}

/** Dossier le plus profond qui contient toutes les entrées, chaîne vide à la racine. */
function commonParent(paths: string[]): string {
  const parents = paths.map((path) => path.split('/').slice(0, -1))
  const first = parents[0] ?? []
  let depth = 0
  while (depth < first.length && parents.every((parts) => parts[depth] === first[depth])) {
    depth += 1
  }
  return first.slice(0, depth).join('/')
}

/**
 * Inventaire de l'archive, fait avant d'écrire le moindre octet : un dépassement doit
 * répondre une erreur lisible, pas couper un téléchargement déjà commencé.
 *
 * Les noms partent du dossier commun de la sélection : deux dossiers `src` venus de
 * deux paquets gardent ce qui les distingue, et un dossier seul arrive sous son nom.
 * Ni `.git` ni les liens symboliques ne sont parcourus, comme dans l'arborescence.
 */
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

    // Le dossier a son entrée à lui : sans elle, un dossier vide disparaîtrait de
    // l'archive, et la structure rapportée ne serait plus celle du disque.
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

/**
 * Le format zip ne date rien hors de 1980–2107, et fflate refuse l'entrée plutôt que de
 * tronquer : un fichier daté de 1970 (archive reproductible, magasin Nix) ferait
 * échouer tout le téléchargement.
 */
function zipDate(date: Date): Date {
  const year = date.getFullYear()
  if (year < 1980) return new Date(1980, 0, 1, 12)
  if (year > 2099) return new Date(2099, 11, 31, 12)
  return date
}

/**
 * Écrit l'archive en flux, un fichier à la fois.
 *
 * Rien n'est assemblé en mémoire, et la lecture attend que le client ait vidé ce qui
 * est déjà parti : fflate ne connaît pas la contre-pression, et sans cette attente un
 * téléchargement lent accumulerait l'archive entière dans le tas du serveur.
 */
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

  /** Attend que le client reprenne, ou qu'il s'en aille : `drain` ne vient plus alors. */
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

      // Ouvert avant d'annoncer l'entrée : un fichier disparu depuis l'inventaire est
      // simplement absent de l'archive, au lieu d'y laisser une entrée vide. Ni lien
      // suivi, ni tube nommé qui bloquerait la lecture en attendant un producteur.
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
