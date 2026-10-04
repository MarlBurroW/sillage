import { unzipSync, zipSync, type Zippable } from 'fflate'
import { SKILL_MAIN_FILE } from '@sillage/protocol'
import { badRequest } from '../http/errors.js'
import { assertSkillFilePath } from './validate.js'

/**
 * Archives de skills : le `.zip` d'un dossier, ou le `.skill` que produit
 * `package_skill.py` dans anthropics/skills, qui est un zip sous un autre nom.
 *
 * Le dossier d'un navigateur arrive aussi par ici, zippé côté client : un seul chemin
 * d'import, donc un seul endroit où vérifier ce qui entre.
 */

/** Un skill tient en quelques fichiers ; au-delà, c'est un dépôt entier déposé par erreur. */
const MAX_FILES = 500
/** Taille décompressée totale, vérifiée avant de décompresser : contre la bombe zip. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024

/** Déchets d'archiveurs, qu'aucun skill ne veut voir arriver dans son dossier. */
const IGNORED = /(^|\/)(__MACOSX|\.DS_Store)(\/|$)/

class ArchiveTooLarge extends Error {}

/**
 * Les fichiers du skill, en chemins relatifs à son dossier.
 *
 * `SKILL.md` est attendu à la racine de l'archive, ou dans un unique dossier de premier
 * niveau, comme quand on zippe le dossier lui-même. Chaque chemin repasse par
 * `assertSkillFilePath` : c'est ce qui arrête une entrée `../../.bashrc`.
 */
export function readSkillArchive(data: Uint8Array): Map<string, Uint8Array> {
  let count = 0
  let total = 0
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(data, {
      filter: (file) => {
        if (file.name.endsWith('/') || IGNORED.test(file.name)) return false
        count += 1
        total += file.originalSize
        if (count > MAX_FILES || total > MAX_TOTAL_BYTES) throw new ArchiveTooLarge()
        return true
      },
    })
  } catch (err) {
    if (err instanceof ArchiveTooLarge) {
      throw badRequest('skill_archive_too_large', 'The archive holds more than {files} files or {megabytes} MB.', {
        files: MAX_FILES,
        megabytes: MAX_TOTAL_BYTES / 1024 / 1024,
      })
    }
    throw badRequest('skill_archive_invalid', 'The file is not a readable zip archive.')
  }

  const paths = Object.keys(entries)
  let prefix = ''
  if (!paths.includes(SKILL_MAIN_FILE)) {
    const tops = new Set(paths.map((path) => path.split('/')[0]))
    const [top] = tops
    if (tops.size !== 1 || !paths.includes(`${top}/${SKILL_MAIN_FILE}`)) {
      throw badRequest(
        'skill_archive_no_skill',
        'The archive has no SKILL.md at its root or in a single top-level folder.',
      )
    }
    prefix = `${top}/`
  }

  const files = new Map<string, Uint8Array>()
  for (const [path, content] of Object.entries(entries)) {
    files.set(assertSkillFilePath(path.slice(prefix.length), { allowMain: true }), content)
  }
  return files
}

/** Le skill dans un dossier à son nom : dézippé, il redonne un dossier de skill. */
export function writeSkillArchive(name: string, files: Map<string, Uint8Array>): Uint8Array {
  const zippable: Zippable = {}
  for (const [path, content] of files) zippable[`${name}/${path}`] = content
  return zipSync(zippable, { level: 6 })
}
