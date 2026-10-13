import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * La connexion qui sert de jauge à un abonnement Claude.
 *
 * Le jeton de `claude setup-token` ne porte que la portée `user:inference` : le CLI
 * tient alors les limites du forfait pour inapplicables et ne les lit pas (sondé sur
 * 2.1.296). Une connexion `claude auth login` porte `user:profile`, mais elle vit dans
 * un dossier de configuration, et donner ce dossier aux sessions séparerait leurs
 * transcripts et leur mémoire de ceux que Sillage lit dans `~/.claude`.
 *
 * D'où un dossier par compte, `<données>/claude-accounts/<id>`, qui ne sert qu'aux
 * lectures d'usage : le CLI y est lancé avec `CLAUDE_CONFIG_DIR`, y lit sa connexion et
 * la renouvelle lui-même quand elle expire. Les sessions gardent le jeton.
 */

/** Ce qu'une connexion du CLI laisse dans son dossier et qui doit être gardé. */
const KEPT = ['.credentials.json', '.claude.json']

export class ClaudeAccountGauges {
  constructor(private readonly root: string) {}

  path(accountId: string): string {
    return join(this.root, accountId)
  }

  /** Vrai quand le dossier porte une connexion à lire. */
  has(accountId: string): boolean {
    return existsSync(join(this.path(accountId), '.credentials.json'))
  }

  /**
   * Le courriel du compte connecté, tel que le CLI l'a écrit : c'est ce qui permet de
   * voir qu'on a bien autorisé le même compte que celui du jeton.
   */
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

  /**
   * Reprend la connexion faite dans un dossier jetable. Rien n'est écrit dans le dossier
   * du compte tant qu'elle n'a pas abouti : une connexion ratée ne doit pas défaire la
   * précédente. Copié puis renommé, pour qu'une lecture ne tombe jamais sur un dossier
   * à moitié écrit.
   */
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
