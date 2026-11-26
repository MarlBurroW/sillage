import type { ConversationRow } from '@sillage/db'
import type { AgentConfig } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import { notFound } from '../http/errors.js'
import type { ClaudeAccountStore } from '../claude-accounts/store.js'
import { claudeCredential } from '../agents/claude/credential.js'
import type { CodexAccountHomes } from '../codex-accounts/homes.js'
import type { CodexAccountStore } from '../codex-accounts/store.js'
import type { GrokAccountHomes } from '../grok-accounts/homes.js'
import type { GrokAccountStore } from '../grok-accounts/store.js'
import type { AntigravityAccountHomes } from '../antigravity-accounts/homes.js'
import type { AntigravityAccountStore } from '../antigravity-accounts/store.js'

/** Which account a session runs on: the environment its CLI starts with and the home each CLI keeps per account. */
export class SessionAccounts {
  constructor(
    private readonly log: EventLog,
    private readonly claudeAccounts: ClaudeAccountStore,
    private readonly codexAccounts: { store: CodexAccountStore; homes: CodexAccountHomes },
    private readonly grokAccounts: { store: GrokAccountStore; homes: GrokAccountHomes },
    readonly antigravityAccounts: { store: AntigravityAccountStore; homes: AntigravityAccountHomes },
  ) {}

  /** Selected Claude account tokens placed in variables taking precedence over stored CLI authentication (probed 2.1.296). Nothing for CLI-default authentication or other agents. Missing/deleted/foreign shared-project account references do not block startup: fall back to CLI login and disclose it in history because a different subscription pays. */
  accountEnv(conversation: ConversationRow, config: AgentConfig): Record<string, string> {
    if (config.agent === 'antigravity') {
      const home = this.antigravityHome(conversation.userId, config.account)
      return { ...(home ? { GEMINI_HOME: home } : {}), SILLAGE_ANTIGRAVITY_SESSION_ROOT: this.antigravityAccounts.homes.sessions(conversation.userId) }
    }
    if (config.agent === 'opencode' || !config.account) return {}
    const missing = (code: string, message: string) => {
      this.log.append(conversation.id, { type: 'error', code, message, recoverable: true })
      return {}
    }
    if (config.agent === 'claude') {
      const resolved = this.claudeAccounts.resolveToken(conversation.userId, config.account)
      if (!resolved) {
        return missing(
          'claude_account_missing',
          "Le compte Claude choisi pour cette conversation n'existe plus : la session repart sur la connexion du CLI.",
        )
      }
      // Both override stored CLI authentication; noninteractive API keys are accepted
      // without prompts (probed 2.1.296).
      return resolved.kind === 'apiKey'
        ? { ANTHROPIC_API_KEY: resolved.token }
        : { CLAUDE_CODE_OAUTH_TOKEN: resolved.token }
    }
    // Grok follows Codex: per-account `GROK_HOME` with account-specific authentication.
    // Never-connected accounts count as absent.
    if (config.agent === 'grok') {
      const account = this.grokAccounts.store.find(conversation.userId, config.account)
      if (!account || account.status !== 'ready') {
        return missing(
          'grok_account_missing',
          account
            ? "Le compte Grok choisi pour cette conversation n'est pas connecté : la session repart sur la connexion du CLI."
            : "Le compte Grok choisi pour cette conversation n'existe plus : la session repart sur la connexion du CLI.",
        )
      }
      return { GROK_HOME: this.grokAccounts.homes.ensure(account.id) }
    }
    // Codex account home, where only auth.json is account-specific. Accounts never
    // connected count as absent: without auth.json, app-servers reject turns.
    const account = this.codexAccounts.store.find(conversation.userId, config.account)
    if (!account || account.status !== 'ready') {
      return missing(
        'codex_account_missing',
        account
          ? "Le compte Codex choisi pour cette conversation n'est pas connecté : la session repart sur la connexion du CLI."
          : "Le compte Codex choisi pour cette conversation n'existe plus : la session repart sur la connexion du CLI.",
      )
    }
    return { CODEX_HOME: this.codexAccounts.homes.ensure(account.id) }
  }

  antigravityHome(userId: string, accountId: string | null): string | undefined {
    if (!accountId) return undefined
    const account = this.antigravityAccounts.store.find(userId, accountId)
    if (!account || account.status !== 'ready') throw notFound('agent_account_not_found', 'Unknown connected Google account.')
    return this.antigravityAccounts.homes.ensure(account.id)
  }

  codexHome(userId: string, accountId: string | null): string | undefined {
    if (!accountId) return undefined
    const account = this.codexAccounts.store.find(userId, accountId)
    if (!account || account.status !== 'ready') throw notFound('agent_account_not_found', 'Unknown connected Codex account.')
    return this.codexAccounts.homes.ensure(account.id)
  }

  grokHome(userId: string, accountId: string | null): string | undefined {
    if (!accountId) return undefined
    const account = this.grokAccounts.store.find(userId, accountId)
    if (!account || account.status !== 'ready') throw notFound('agent_account_not_found', 'Unknown connected Grok account.')
    return this.grokAccounts.homes.ensure(account.id)
  }

  /** Credential handed to an adapter's model catalog for the account the configuration names: plans differ in which models they list. */
  catalogCredential(userId: string, config: AgentConfig): string | undefined {
    let credential: string | undefined
    if (config.agent === 'antigravity') credential = this.antigravityHome(userId, config.account)
    else if (config.agent === 'codex') credential = this.codexHome(userId, config.account)
    else if (config.agent === 'grok') credential = this.grokHome(userId, config.account)
    else if (config.agent === 'claude' && config.account) {
      const resolved = this.claudeAccounts.resolveToken(userId, config.account)
      if (!resolved) throw notFound('agent_account_not_found', 'Unknown Claude account.')
      credential = claudeCredential(resolved.kind, resolved.token)
    }
    return credential
  }
}
