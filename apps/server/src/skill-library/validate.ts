import { SKILL_MAIN_FILE, skillFilePathSchema } from '@sillage/protocol'
import { badRequest } from '../http/errors.js'

/**
 * Chemin d'un fichier dans le dossier d'un skill, vérifié avant tout accès au disque.
 *
 * C'est ici que se joue l'évasion hors du dossier : un `..` venu d'une requête ou d'une
 * archive écrirait n'importe où sous l'utilisateur du serveur. Le schéma du protocole
 * refuse les chemins absolus et les segments vides, `.` ou `..`.
 *
 * `SKILL.md` est réservé par défaut : son frontmatter porte le nom, qui doit rester
 * celui du dossier, et il s'édite par les champs du skill. L'import et la reprise, qui
 * l'écrivent légitimement, le demandent explicitement.
 */
export function assertSkillFilePath(path: string, options: { allowMain?: boolean } = {}): string {
  if (!skillFilePathSchema.safeParse(path).success) {
    throw badRequest('skill_file_path_invalid', 'Invalid file path in a skill: {path}.', { path })
  }
  if (!options.allowMain && path === SKILL_MAIN_FILE) {
    throw badRequest('skill_file_reserved', 'SKILL.md is edited through the fields of the skill.')
  }
  return path
}
