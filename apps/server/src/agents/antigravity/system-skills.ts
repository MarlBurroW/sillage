import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillMarkdown } from '../../skill-library/frontmatter.js'

/**
 * Antigravity 1.4.3 materializes its system skills (`run-workflow`, frontmatter
 * `metadata.namespace: system`) into `<session cwd>/skills/system/` at `session/new`: the ACP
 * session's directory, not the process's (probed 26 Nov 2026), so no launch option moves it. The
 * agent reads that file on demand during the session, so it stays until the last Antigravity
 * session in the folder stops, then goes: a project repository must not keep tool files.
 */

const sessions = new Map<string, number>()

/** Counts an Antigravity session working in `cwd`, so another one stopping leaves its skills. */
export function claimSystemSkills(cwd: string): void {
  sessions.set(cwd, (sessions.get(cwd) ?? 0) + 1)
}

/** Releases a claim; the last session out removes what Antigravity materialized. Idempotent per claim. */
export function releaseSystemSkills(cwd: string): void {
  const count = sessions.get(cwd) ?? 0
  if (count > 1) {
    sessions.set(cwd, count - 1)
    return
  }
  sessions.delete(cwd)
  if (count === 1) removeMaterializedSystemSkills(cwd)
}

/** True when git tracks something under `path`: the user's own files, never ours to delete. */
function tracked(cwd: string, path: string): boolean {
  const result = spawnSync('git', ['ls-files', '--', path], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 && result.stdout.trim() !== ''
}

/**
 * Removes the system skills Antigravity wrote under `cwd`, recognized by their namespace and only
 * when untracked, then the `skills/system` and `skills` folders if that left them empty. Anything
 * else in those folders is left alone. Returns the removed skill names.
 */
export function removeMaterializedSystemSkills(cwd: string): string[] {
  const system = join(cwd, 'skills', 'system')
  let entries: string[]
  try {
    entries = readdirSync(system)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of entries) {
    let metadata: unknown
    try {
      metadata = parseSkillMarkdown(readFileSync(join(system, name, 'SKILL.md'), 'utf8')).data.metadata
    } catch {
      continue
    }
    if ((metadata as { namespace?: unknown } | null)?.namespace !== 'system') continue
    if (tracked(cwd, join('skills', 'system', name))) continue
    rmSync(join(system, name), { recursive: true, force: true })
    removed.push(name)
  }
  // rmdir refuses a non-empty folder: a user's own skills keep both levels in place.
  for (const dir of [system, join(cwd, 'skills')]) {
    try {
      rmdirSync(dir)
    } catch {
      break
    }
  }
  return removed
}
