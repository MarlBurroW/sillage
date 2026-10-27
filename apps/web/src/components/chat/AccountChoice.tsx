import { useAntigravityAccounts } from '../../lib/antigravity-accounts'
import { IdCard } from 'lucide-react'
import type { AgentConfig, AgentUsage } from '@sillage/protocol'
import { useClaudeAccounts } from '../../lib/claude-accounts'
import { useCodexAccounts } from '../../lib/codex-accounts'
import { useGrokAccounts } from '../../lib/grok-accounts'
import { useTranslate } from '../../lib/i18n'
import { busiestWindows, useAccountsUsage } from '../../lib/usage'
import { ChoiceList, type Choice } from '../ui'

/**
 * Account selection before the first message. The composer already hides this among settings, but
 * approaching subscription limits makes it central when starting sessions. Show usage per option
 * for informed choice before a turn. Omit without additional accounts because implicit CLI login
 * needs no screen space.
 */

/** CLI-login display value: null cannot be an option value. */
const CLI_ACCOUNT = 'cli'

/** gauged means readable subscription usage: a Claude subscription token, Antigravity with OAuth. */
type Account = { id: string; label: string; kind: 'apiKey' | 'chatgpt' | 'grok' | 'gauged' }

/** Most loaded window first, then the next: the data determining selection. */
function summarize(usage: AgentUsage | undefined, t: ReturnType<typeof useTranslate>): string | undefined {
  if (!usage) return undefined
  if (!usage.limitsAvailable || usage.windows.length === 0) return t('draft.account.noGauge')
  const ranked = busiestWindows(usage)
  if (ranked.length === 0) return undefined
  return ranked.map((window) => `${window.label} ${Math.round(window.utilization * 100)} %`).join(' · ')
}

export function AccountChoice({
  config,
  onChange,
  enabled,
}: {
  config: AgentConfig
  onChange: (config: AgentConfig) => void
  enabled: boolean
}) {
  const t = useTranslate()
  const isClaude = config.agent === 'claude'
  const isCodex = config.agent === 'codex'
  const isAntigravity = config.agent === 'antigravity'
  const { data: antigravityList } = useAntigravityAccounts(isAntigravity)
  const isGrok = config.agent === 'grok'
  const { data: claudeList } = useClaudeAccounts(isClaude)
  const { data: codexList } = useCodexAccounts(isCodex)
  const { data: grokList } = useGrokAccounts(isGrok)

  const accounts: Account[] = isClaude
    ? (claudeList?.accounts ?? []).map((account) => ({
        id: account.id,
        label: account.label,
        kind: account.kind === 'oauth' ? ('gauged' as const) : account.kind,
      }))
    : isCodex
      ? (codexList?.accounts ?? [])
          // Do not offer disconnected homes that would reject turns.
          .filter((account) => account.status === 'ready')
          // API keys have no subscription: preview with prose like Claude.
          .map((account) => ({
            id: account.id,
            label: account.label,
            kind: account.authMode === 'apiKey' ? ('apiKey' as const) : ('chatgpt' as const),
          }))
      : isGrok
        ? (grokList?.accounts ?? [])
            // Same rule as Codex: omit disconnected homes; API keys have no credit allowance to probe.
            .filter((account) => account.status === 'ready')
            .map((account) => ({
              id: account.id,
              label: account.label,
              kind: account.authMode === 'apiKey' ? ('apiKey' as const) : ('grok' as const),
            }))
        : isAntigravity ? (antigravityList?.accounts ?? []).filter((account) => account.status === 'ready').map((account) => ({ id: account.id, label: account.label, kind: account.authMode?.startsWith('oauth-') ? ('gauged' as const) : ('apiKey' as const) })) : []

  const chosen = config.agent === 'opencode' ? null : config.account
  // CLI login then accounts. API keys have no plan: probing returns nothing, so use prose previews.
  const probed: (string | null)[] = [
    null,
    ...accounts.filter((account) => account.kind !== 'apiKey').map((account) => account.id),
  ]
  const usages = useAccountsUsage(config.agent, probed, enabled && accounts.length > 0)
  const usageOf = (account: string | null) => usages[probed.indexOf(account)]

  if (config.agent === 'opencode' || accounts.length === 0) return null

  const hintFor = (account: Account | null): string | undefined => {
    if (account?.kind === 'apiKey') return t('draft.account.apiKey')
    const query = usageOf(account?.id ?? null)
    if (query?.error) return t('draft.account.unreadable')
    if (query?.isPending) return t('draft.account.reading')
    return summarize(query?.data, t)
  }

  const options: Choice<string>[] = [
    { value: CLI_ACCOUNT, label: t('composer.account.cli'), hint: hintFor(null), icon: <IdCard size={15} /> },
    ...accounts.map((account) => ({ value: account.id, label: account.label, hint: hintFor(account), icon: <IdCard size={15} /> })),
  ]
  // Explain accounts deleted since being saved as defaults rather than losing them silently.
  if (chosen && !accounts.some((account) => account.id === chosen)) {
    options.push({ value: chosen, label: t('composer.account.missing'), hint: t('draft.account.missing') })
  }

  return (
    <ChoiceList
      label={t('draft.account.legend')}
      value={chosen ?? CLI_ACCOUNT}
      options={options}
      onChange={(value) => onChange({ ...config, account: value === CLI_ACCOUNT ? null : value, ...(config.agent === 'antigravity' ? { model: '', reasoningEffort: '' } : {}) })}
    />
  )
}
