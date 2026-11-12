import type { ClaudeAccountKind } from '@sillage/protocol'

/**
 * Additional Claude accounts reach adapters as one string, like Codex and Grok homes. Both kinds
 * must survive: the model catalog and subscription type depend on whichever authentication the
 * probe runs under, so an API key cannot be reduced to "no plan".
 */
export function claudeCredential(kind: ClaudeAccountKind, token: string): string {
  return `${kind}:${token}`
}

export function parseClaudeCredential(credential: string): { kind: ClaudeAccountKind; token: string } | null {
  const separator = credential.indexOf(':')
  if (separator <= 0) return null
  const kind = credential.slice(0, separator)
  if (kind !== 'oauth' && kind !== 'apiKey') return null
  return { kind, token: credential.slice(separator + 1) }
}

/** Credential of the account a session's launch environment carries; undefined for the CLI's own login. Inverse of the variables `SessionManager` sets. */
export function claudeCredentialOfEnv(env: Record<string, string> | undefined): string | undefined {
  if (env?.ANTHROPIC_API_KEY) return claudeCredential('apiKey', env.ANTHROPIC_API_KEY)
  if (env?.CLAUDE_CODE_OAUTH_TOKEN) return claudeCredential('oauth', env.CLAUDE_CODE_OAUTH_TOKEN)
  return undefined
}

/** Authentication that would take precedence over the one a probe sets (documented precedence). */
export function withoutAuthOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'NODE_ENV']) {
    delete next[name]
  }
  return next
}

/** Probe environment for an account, or the CLI's own login when absent. Same variables as session launches (probed 2.1.296). */
export function claudeAuthEnv(credential?: string): Record<string, string> | undefined {
  const parsed = credential ? parseClaudeCredential(credential) : null
  if (!parsed) return undefined
  const base = withoutAuthOverrides(process.env) as Record<string, string>
  return parsed.kind === 'apiKey'
    ? { ...base, ANTHROPIC_API_KEY: parsed.token }
    : { ...base, CLAUDE_CODE_OAUTH_TOKEN: parsed.token }
}
