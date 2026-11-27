import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linksTo, linkTo } from '../platform/links.js'

/**
 * Additional account `COPILOT_HOME`s, following `GrokAccountHomes`: one directory per account
 * where only the sign-in and what depends on it are real, every other entry of the user's home
 * linked. Sessions (`session-state/`, `session-store.db`) are shared, so a conversation resumes
 * from any account's home; probed on 1.0.116 with a session started in one home and resumed in
 * another through links, SQLite's side files landing next to the real database.
 */

/** Server `$COPILOT_HOME`, falling back to `~/.copilot`, holding the CLI's own sign-in. */
export function userCopilotHome(): string {
  return process.env.COPILOT_HOME || join(homedir(), '.copilot')
}

/**
 * Account-specific entries. `config.json` holds the token (or, with a keychain, the login whose
 * keychain entry holds it) next to state Copilot manages itself; `settings.json` is derived at
 * each launch (see `ensure`); logs are per process anyway.
 */
const PRIVATE = new Set(['config.json', 'settings.json', 'settings.json.lock', 'logs'])

/** `config.json` and `settings.json` may open with `//` comment lines. */
function readJsonc(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export interface CopilotIdentity { login: string; host: string }

/** Login of a home, from the `lastLoggedInUser` Copilot writes into `config.json`; null when signed out. */
export function copilotIdentity(home: string): CopilotIdentity | null {
  const config = readJsonc(join(home, 'config.json'))
  const last = config?.lastLoggedInUser as Record<string, unknown> | undefined
  const users = Array.isArray(config?.loggedInUsers) ? config.loggedInUsers as Record<string, unknown>[] : []
  const user = last && typeof last.login === 'string' ? last : users.find((entry) => typeof entry?.login === 'string')
  if (!user) return null
  return { login: String(user.login), host: typeof user.host === 'string' ? user.host : 'https://github.com' }
}

export class CopilotAccountHomes {
  constructor(private readonly root: string) {}

  path(accountId: string): string {
    return join(this.root, accountId)
  }

  /** Creates missing homes, refreshes links and settings, and returns their path. */
  ensure(accountId: string): string {
    const home = this.path(accountId)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const source = userCopilotHome()
    // Sessions must be shared from the first launch: a home that created its own folder would
    // keep its sessions to itself, since real entries are never replaced by links.
    mkdirSync(join(source, 'session-state'), { recursive: true })

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
        if (!current.isSymbolicLink()) continue
        if (linksTo(link, target)) continue
        unlinkSync(link)
      }
      if (name.endsWith('.db') && process.platform === 'win32') {
        // `linkTo` falls back to a hard link on Windows without symlink rights. SQLite keeps its
        // side files next to the path it opened, so two paths to one database would each get
        // their own journal: leave the account its own index instead.
        try { symlinkSync(target, link, 'file') } catch { /* no symlink right: skip */ }
        continue
      }
      linkTo(target, link)
    }

    // The user's settings, plus consent to the plain-text fallback: without a keychain (a
    // server), a sign-in with no terminal to accept that fallback succeeds on GitHub and then
    // fails with "the token was not saved". Where a keychain exists, Copilot still uses it.
    const settings = { ...readJsonc(join(source, 'settings.json')), storeTokenPlaintext: true }
    writeFileSync(join(home, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    return home
  }

  /** Whether the home holds a sign-in; never signed in or signed out reads as false. */
  connected(accountId: string): boolean {
    return copilotIdentity(this.path(accountId)) !== null
  }
}
