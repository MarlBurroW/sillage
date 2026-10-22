import { SKILL_MAIN_FILE, skillFilePathSchema } from '@sillage/protocol'
import { badRequest } from '../http/errors.js'

/** File path inside a skill directory, checked before all disk access. Prevents escape: request or archive `..` entries could write anywhere as the server user. Protocol schemas reject absolute paths and empty, `.` or `..` segments. Reserve `SKILL.md` by default because its frontmatter name must match the directory and is edited through skill fields. Import and adoption explicitly opt into writing it. */
export function assertSkillFilePath(path: string, options: { allowMain?: boolean } = {}): string {
  if (!skillFilePathSchema.safeParse(path).success) {
    throw badRequest('skill_file_path_invalid', 'Invalid file path in a skill: {path}.', { path })
  }
  if (!options.allowMain && path === SKILL_MAIN_FILE) {
    throw badRequest('skill_file_reserved', 'SKILL.md is edited through the fields of the skill.')
  }
  return path
}
