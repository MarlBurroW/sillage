import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_MAIN_FILE, skillNameSchema, type LocalSkillDto, type LocalSkillOrigin } from '@sillage/protocol'
import { parseSkillMarkdown } from './frontmatter.js'

/** Existing machine skills read separately by each CLI. Listing supports library adoption so both CLIs can use them, and detects duplicate names that would hide Claude's `/nom` alias and appear twice in Codex. User directories are scanned only for administrators because they expose the system account's home; repository directories follow project visibility. */

interface ScanRoot {
  origin: LocalSkillOrigin
  dir: string
  /** CLI-managed entries that should not be adopted: account-synchronized Claude skills and bundled Codex skills. */
  skip: string[]
}

export interface LocalScanOptions {
  /** Home directory to scan, or null to limit scanning to the repository. */
  home: string | null
  /** `$CODEX_HOME`, falling back to `~/.codex`. */
  codexHome: string | null
  /** Project workspace, null outside projects. */
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
      // Personal skills often symlink to repositories: follow them for reads and use
      // the real directory as the adoption key.
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
