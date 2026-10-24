import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSkillDto } from '@sillage/protocol'
import { parseSkillMarkdown } from '../../skill-library/frontmatter.js'

/** Mirrors the four native skill roots from the pinned ACP distribution.
 * Library skills have already been copied into the session's global root. */
export function antigravitySkills(home: string, cwd: string): Map<string, AgentSkillDto & { path: string }> {
  const found = new Map<string, AgentSkillDto & { path: string }>()
  for (const root of [join(home, 'config', 'skills'), join(cwd, '.gemini', 'skills'), join(home, 'antigravity-cli', 'skills'), join(cwd, '.agents', 'skills')]) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.')) continue
      const path = join(root, entry, 'SKILL.md')
      try {
        const { data } = parseSkillMarkdown(readFileSync(path, 'utf8'))
        const name = typeof data.name === 'string' ? data.name : entry
        found.set(name, { name, description: typeof data.description === 'string' ? data.description : '', path })
      } catch { /* Native loaders also ignore invalid skill entries. */ }
    }
  }
  return found
}
