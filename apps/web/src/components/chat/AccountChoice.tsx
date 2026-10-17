import { IdCard } from 'lucide-react'
import type { AgentConfig, AgentUsage, UsageWindow } from '@sillage/protocol'
import { useClaudeAccounts } from '../../lib/claude-accounts'
import { useCodexAccounts } from '../../lib/codex-accounts'
import { useTranslate } from '../../lib/i18n'
import { useAccountsUsage } from '../../lib/usage'
import { ChoiceList, type Choice } from '../ui'

/**
 * Sur quel compte la session va partir, choisi avant le premier message.
 *
 * Le composer porte déjà ce réglage, mais replié parmi les autres : au moment d'ouvrir
 * une session, c'est pourtant la question qui compte quand un abonnement approche de
 * sa limite. Chaque option dit donc où en est son compte, pour choisir d'après l'usage
 * plutôt que de le découvrir au milieu d'un tour.
 *
 * Absent tant qu'il n'y a pas de compte supplémentaire : sans choix, la connexion du
 * CLI va de soi et n'a pas à prendre de place.
 */

/** Valeur de la connexion du CLI : `null` n'est pas une valeur d'option. */
const CLI_ACCOUNT = 'cli'

/** `gauged` : un abonnement dont l'usage se lit, ChatGPT ou Claude avec sa jauge. */
type Account = { id: string; label: string; kind: 'oauth' | 'apiKey' | 'chatgpt' | 'gauged' }

/** La fenêtre la plus chargée, puis la suivante : ce qui décide d'un choix. */
function summarize(usage: AgentUsage | undefined, t: ReturnType<typeof useTranslate>): string | undefined {
  if (!usage) return undefined
  if (!usage.limitsAvailable || usage.windows.length === 0) return t('draft.account.noGauge')
  const ranked = [...usage.windows]
    .filter((window): window is UsageWindow & { utilization: number } => window.utilization !== null)
    .sort((a, b) => b.utilization - a.utilization)
    .slice(0, 2)
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
  const { data: claudeList } = useClaudeAccounts(isClaude)
  const { data: codexList } = useCodexAccounts(isCodex)

  const accounts: Account[] = isClaude
    ? (claudeList?.accounts ?? []).map((account) => ({
        id: account.id,
        label: account.label,
        kind: account.kind === 'oauth' && account.gauge ? ('gauged' as const) : account.kind,
      }))
    : isCodex
      ? (codexList?.accounts ?? [])
          // Un home sans connexion refuserait le tour : il ne se propose pas.
          .filter((account) => account.status === 'ready')
          // Une clé API n'a pas de forfait : son aperçu est une phrase, comme côté Claude.
          .map((account) => ({
            id: account.id,
            label: account.label,
            kind: account.authMode === 'apiKey' ? ('apiKey' as const) : ('chatgpt' as const),
          }))
      : []

  const chosen = config.agent === 'opencode' || config.agent === 'grok' ? null : config.account
  // La connexion du CLI, puis les comptes. Un jeton de setup-token sans jauge ne lit pas
  // son forfait, une clé API n'en a pas : les sonder ne rendrait rien, leur aperçu est une
  // phrase.
  const probed: (string | null)[] = [
    null,
    ...accounts.filter((account) => account.kind !== 'oauth' && account.kind !== 'apiKey').map((account) => account.id),
  ]
  const usages = useAccountsUsage(config.agent, probed, enabled && accounts.length > 0)
  const usageOf = (account: string | null) => usages[probed.indexOf(account)]

  if (config.agent === 'opencode' || config.agent === 'grok' || accounts.length === 0) return null

  const hintFor = (account: Account | null): string | undefined => {
    if (account?.kind === 'oauth') return t('draft.account.tokenNoGauge')
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
  // Un compte supprimé depuis que le défaut le désigne : dit plutôt que perdu.
  if (chosen && !accounts.some((account) => account.id === chosen)) {
    options.push({ value: chosen, label: t('composer.account.missing'), hint: t('draft.account.missing') })
  }

  return (
    <ChoiceList
      label={t('draft.account.legend')}
      value={chosen ?? CLI_ACCOUNT}
      options={options}
      onChange={(value) => onChange({ ...config, account: value === CLI_ACCOUNT ? null : value })}
    />
  )
}
