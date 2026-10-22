import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Authentication used for Claude subscription gauges. setup-token carries only `user:inference`, making CLI subscription limits inapplicable and unread (probed 2.1.296). auth login carries `user:profile` but lives in configuration directories; giving those to sessions would separate transcripts and memory from Sillage's `~/.claude` reads. Use per-account `<data>/claude-accounts/<id>` only for usage reads, with `CLAUDE_CONFIG_DIR`; CLIs read and refresh their own authentication there while sessions retain tokens. */

/** CLI authentication files that must be retained. */
const KEPT = ['.credentials.json', '.claude.json']

export class ClaudeAccountGauges {
  constructor(private readonly root: string) {}

  path(accountId: string): string {
    return join(this.root, accountId)
  }

  /** Whether directories contain readable authentication. */
  has(accountId: string): boolean {
    return existsSync(join(this.path(accountId), '.credentials.json'))
  }

  /** Connected account email as written by the CLI, allowing users to verify they authorized the token's account. */
  email(accountId: string): string | null {
    try {
      const config = JSON.parse(readFileSync(join(this.path(accountId), '.claude.json'), 'utf8')) as {
        oauthAccount?: { emailAddress?: unknown }
      }
      const email = config.oauthAccount?.emailAddress
      return typeof email === 'string' ? email : null
    } catch {
      return null
    }
  }

  describe(accountId: string): { email: string | null } | null {
    return this.has(accountId) ? { email: this.email(accountId) } : null
  }

  /** Adopts authentication from disposable directories. Write nothing to account directories until success so failed logins preserve previous credentials. Copy then rename to prevent reads of partial directories. */
  adopt(accountId: string, staging: string): void {
    if (!existsSync(join(staging, '.credentials.json'))) {
      throw new Error("La connexion n'a pas laissé d'identifiants dans son dossier.")
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const next = `${this.path(accountId)}.next`
    rmSync(next, { recursive: true, force: true })
    mkdirSync(next, { mode: 0o700 })
    for (const name of KEPT) {
      if (!existsSync(join(staging, name))) continue
      copyFileSync(join(staging, name), join(next, name))
      chmodSync(join(next, name), 0o600)
    }
    this.forget(accountId)
    renameSync(next, this.path(accountId))
  }

  forget(accountId: string): void {
    rmSync(this.path(accountId), { recursive: true, force: true })
  }
}
