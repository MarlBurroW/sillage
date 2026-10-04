import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_MAIN_FILE, skillNameSchema, type LocalSkillDto, type LocalSkillOrigin } from '@sillage/protocol'
import { parseSkillMarkdown } from './frontmatter.js'

/**
 * Les skills déjà présents sur la machine, que chaque CLI lit de son côté.
 *
 * Les lister sert deux fins : les reprendre dans la bibliothèque, pour qu'ils servent
 * aux deux CLI et non à un seul ; et repérer un homonyme, qui masquerait l'alias `/nom`
 * côté Claude et apparaîtrait deux fois côté Codex.
 *
 * Les dossiers de l'utilisateur ne sont lus que pour un administrateur : ils exposent le
 * dossier personnel du compte système. Ceux du dépôt suivent la visibilité du projet.
 */

interface ScanRoot {
  origin: LocalSkillOrigin
  dir: string
  /**
   * Entrées gérées par le CLI lui-même, qu'il n'y a pas lieu de reprendre : les skills
   * synchronisés depuis le compte Claude, ceux que Codex embarque.
   */
  skip: string[]
}

export interface LocalScanOptions {
  /** Dossier personnel à parcourir, null pour s'en tenir au dépôt. */
  home: string | null
  /** `$CODEX_HOME`, à défaut `~/.codex`. */
  codexHome: string | null
  /** Workspace du projet, null hors d'un projet. */
  workspace: string | null
}

export function scanLocalSkills(options: LocalScanOptions): LocalSkillDto[] {
  const roots: ScanRoot[] = []
  if (options.home) {
    const codexHome = options.codexHome ?? join(options.home, '.codex')
    roots.push(
      { origin: 'claude-user', dir: join(options.home, '.claude/skills'), skip: ['synced'] },
      { origin: 'agents-user', dir: join(options.home, '.agents/skills'), skip: [] },
      { origin: 'codex-user', dir: join(codexHome, 'skills'), skip: ['.system'] },
    )
  }
  if (options.workspace) {
    roots.push(
      { origin: 'claude-repo', dir: join(options.workspace, '.claude/skills'), skip: [] },
      { origin: 'agents-repo', dir: join(options.workspace, '.agents/skills'), skip: [] },
    )
  }

  const found: LocalSkillDto[] = []
  for (const root of roots) {
    if (!existsSync(root.dir)) continue
    for (const entry of readdirSync(root.dir)) {
      if (root.skip.includes(entry) || entry.startsWith('.')) continue
      // Un skill personnel est souvent un lien vers un dépôt : on le suit pour lire, et
      // c'est le dossier réel qui sert de clé à la reprise.
      let path: string
      try {
        path = realpathSync(join(root.dir, entry))
        if (!statSync(path).isDirectory() || !existsSync(join(path, SKILL_MAIN_FILE))) continue
      } catch {
        continue
      }
      found.push(describe(root.origin, path, entry))
    }
  }
  return found.sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name))
}

function describe(origin: LocalSkillOrigin, path: string, entry: string): LocalSkillDto {
  try {
    const { data } = parseSkillMarkdown(readFileSync(join(path, SKILL_MAIN_FILE), 'utf8'))
    const name = typeof data.name === 'string' ? data.name : entry
    const description = typeof data.description === 'string' ? data.description : ''
    return {
      origin,
      path,
      name,
      description,
      problem: skillNameSchema.safeParse(name).success ? null : 'skill_name_invalid',
    }
  } catch {
    return { origin, path, name: entry, description: '', problem: 'skill_unreadable' }
  }
}
