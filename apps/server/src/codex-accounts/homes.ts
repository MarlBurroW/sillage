import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linksTo, linkTo } from '../platform/links.js'

/** Additional account `CODEX_HOME`. One directory per account with only `auth.json` initially real; other user-home entries are symlinked. Codex therefore shares configuration, skills, memory and especially threads, allowing resume and fork across accounts (probed on 0.162.1). SQLite follows links before placing journals beside real databases. Refresh links on every launch: new Codex versions create entries (`memories/`, `goals_1.sqlite`…) that existing accounts must also see. Real entries Codex creates within account homes (journals, `history.jsonl`) remain account-local and untouched. */

/** Server `$CODEX_HOME`, falling back to `~/.codex`, holding CLI authentication. */
export function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/**
 * Entries that must stay account-local. `models_cache.json` is keyed by auth identity: shared
 * through a link, two accounts would keep overwriting each other's catalog in the user home and
 * the account would start from the other plan's model list.
 */
const PRIVATE = new Set(['auth.json', 'models_cache.json'])

export class CodexAccountHomes {
  constructor(private readonly root: string) {}

  path(accountId: string): string {
    return join(this.root, accountId)
  }

  /** Creates missing homes, refreshes links and returns their path. */
  ensure(accountId: string): string {
    const home = this.path(accountId)
    mkdirSync(home, { recursive: true })
    const source = userCodexHome()
    if (!existsSync(source)) return home

    for (const name of readdirSync(source)) {
      const target = join(source, name)
      const link = join(home, name)
      let current: ReturnType<typeof lstatSync> | null = null
      try {
        current = lstatSync(link)
      } catch {
        current = null
      }
      if (PRIVATE.has(name)) {
        // Homes created before an entry became private still link it: drop the link so Codex
        // recreates the entry locally.
        if (current?.isSymbolicLink()) unlinkSync(link)
        continue
      }
      if (current) {
        // Correct links need no work. Retarget links pointing elsewhere after user-home
        // moves; leave real files and directories as account-owned entries.
        if (!current.isSymbolicLink()) continue
        if (linksTo(link, target)) continue
        unlinkSync(link)
      }
      linkTo(target, link)
    }
    return home
  }

  /** Whether the home contains authentication, meaning `auth.json`. */
  connected(accountId: string): boolean {
    return existsSync(join(this.path(accountId), 'auth.json'))
  }
}
