import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linksTo, linkTo } from '../platform/links.js'

/** Additional account `GROK_HOME`, following `CodexAccountHomes`. One directory per account with only account-specific entries real; symlink the user's other home entries. Grok shares configuration, skills, memory and especially `sessions/`, permitting resume regardless of the originating account. Refresh links every launch so newly created user-home entries reach existing accounts. Grok-created account-local entries such as logs remain local. */

/** Server `$GROK_HOME`, falling back to `~/.grok`, holding CLI authentication. */
export function userGrokHome(): string {
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

/** Account-specific entries: authentication and authentication-dependent caches (model catalogs, remote settings) varying between subscriptions. */
const PRIVATE = new Set(['auth.json', 'models_cache.json', 'settings_cache.json'])

export class GrokAccountHomes {
  constructor(private readonly root: string) {}

  path(accountId: string): string {
    return join(this.root, accountId)
  }

  /** Creates missing homes, refreshes links and returns their path. */
  ensure(accountId: string): string {
    const home = this.path(accountId)
    mkdirSync(home, { recursive: true })
    const source = userGrokHome()
    if (!existsSync(source)) return home

    for (const name of readdirSync(source)) {
      if (PRIVATE.has(name)) continue
      const target = join(source, name)
      const link = join(home, name)
      let current: ReturnType<typeof lstatSync> | null = null
      try {
        current = lstatSync(link)
      } catch {
        current = null
      }
      if (current) {
        // Correct links need no work; retarget incorrect links and leave real files
        // or directories as account-specific entries.
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
