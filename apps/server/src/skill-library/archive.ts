import { unzipSync, zipSync, type Zippable } from 'fflate'
import { SKILL_MAIN_FILE } from '@sillage/protocol'
import { badRequest } from '../http/errors.js'
import { assertSkillFilePath } from './validate.js'

/** Skill archives: directory `.zip` files or `.skill` files from anthropics/skills' `package_skill.py`, which are renamed ZIPs. Browser directory uploads also arrive here, zipped client-side: one import path means one place to validate incoming content. */

/** Skills occupy a few files; larger uploads are likely accidental whole repositories. */
const MAX_FILES = 500
/** Total uncompressed size checked before extraction to prevent ZIP bombs. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024

/** Archiver debris that should never enter skill directories. */
const IGNORED = /(^|\/)(__MACOSX|\.DS_Store)(\/|$)/

class ArchiveTooLarge extends Error {}

/** Skill files relative to their directory. Expect `SKILL.md` at archive root or under a single top-level directory, as when zipping the directory itself. Validate every path with `assertSkillFilePath` to reject entries such as `../../.bashrc`. */
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

/** Skill inside its named directory, producing a skill folder when extracted. */
export function writeSkillArchive(name: string, files: Map<string, Uint8Array>): Uint8Array {
  const zippable: Zippable = {}
  for (const [path, content] of files) zippable[`${name}/${path}`] = content
  return zipSync(zippable, { level: 6 })
}
