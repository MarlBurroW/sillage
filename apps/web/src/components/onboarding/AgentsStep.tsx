import { Check, Download, KeyRound, Plus, TerminalSquare } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { AgentAvailabilityDto, AgentKind, CodexAccount } from '@sillage/protocol'
import { useAgentAvailability, useInstallAgent } from '../../lib/agents'
import { useClaudeAccounts } from '../../lib/claude-accounts'
import { useCodexAccounts, useCreateCodexAccount } from '../../lib/codex-accounts'
import { useTranslate } from '../../lib/i18n'
import { useAgentUsage } from '../../lib/usage'
import { useUpdateAgentDefault, useUserSettings } from '../../lib/user-settings'
import { AddAccountCard as ClaudeAddAccountCard } from '../../routes/ClaudeAccountsSettingsPage'
import { LoginControls as CodexLoginControls } from '../../routes/CodexAccountsSettingsPage'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { Badge, Banner, Button, Card } from '../ui'
import { StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

/** Comment chaque CLI se connecte lui-même, depuis un terminal de la machine. */
const CLI_LOGIN: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex login',
  opencode: 'opencode auth login',
  grok: 'grok login',
}

/**
 * Tes agents : un rang par CLI retenu, avec ce que le serveur en sait.
 *
 * Deux choses à faire comprendre, dans cet ordre : par défaut, une conversation part sur
 * la connexion que le CLI garde lui-même sur la machine, et il n'y a rien à faire si
 * elle existe ; les comptes supplémentaires sont une option, pour un autre abonnement
 * ou une clé API, et le seul chemin de connexion sans terminal.
 */
export function AgentsStep({ nav, state, profile }: StepProps) {
  const t = useTranslate()
  const { data: availability } = useAgentAvailability()
  const chosen: AgentKind[] = state.answers.agents.length > 0 ? state.answers.agents : ['claude']
  const rows = chosen
    .map((agent) => availability?.agents.find((entry) => entry.agent === agent))
    .filter((entry): entry is AgentAvailabilityDto => entry !== undefined)

  useGate(nav, { canContinue: true, laterAllowed: true, skipAllowed: true })
  useCommit(nav, null)

  return (
    <>
      <StepTitle
        title={t('onboarding.agents.title')}
        lead={t('onboarding.agents.lead', { host: t(profile === 'desktop' ? 'onboarding.host.computer' : 'onboarding.host.server') })}
      />
      {state.answers.guidance === 'guided' ? (
        <Why>
          <b>{t('onboarding.agents.why.title')}</b> {t('onboarding.agents.why.body')}
        </Why>
      ) : null}

      {/* Une carte par CLI : son en-tête dit où il en est, son corps ce qui s'y règle. */}
      <div className="flex flex-col gap-3">
        {rows.map((entry) => (
          <AgentRow key={entry.agent} entry={entry} />
        ))}
        {availability && rows.length === 0 ? <p className="text-sm text-ink-faint">{t('onboarding.agents.none')}</p> : null}
      </div>

      {state.answers.agents.length === 0 ? (
        <Why>
          <b>{t('onboarding.agents.beginner.title')}</b> {t('onboarding.agents.beginner.body')}
        </Why>
      ) : null}
      <Tip>{t('onboarding.agents.more')}</Tip>
    </>
  )
}

function AgentRow({ entry }: { entry: AgentAvailabilityDto }) {
  const t = useTranslate()
  const install = useInstallAgent()
  const label = AGENT_LABELS[entry.agent]
  const installing = entry.install.status === 'running'
  // Le forfait que la lecture d'usage rapporte, quand elle y arrive : le signe le plus
  // sûr que le CLI est connecté. Son absence ne prouve pas le contraire.
  const { data: usage } = useAgentUsage(entry.agent, entry.installed)
  const plan = usage?.plan ?? null

  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-high">
          <AgentIcon agent={entry.agent} size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm font-semibold text-ink">{label}</p>
          {entry.installed ? (
            <Badge tone="positive">{t('onboarding.agents.installed', { version: entry.version ?? '' })}</Badge>
          ) : (
            <Badge tone="neutral">{entry.reason === 'disabled' ? t('agent.unavailable.disabled') : t('onboarding.agents.missing')}</Badge>
          )}
        </div>
        {!entry.installed && entry.reason !== 'disabled' ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Download size={14} />}
            disabled={installing || install.isPending}
            onClick={() => install.mutate(entry.agent)}
          >
            {installing
              ? t('agent.install.running', { label, version: entry.install.status === 'running' ? entry.install.version : '' })
              : entry.install.status === 'failed'
                ? t('agent.install.retry')
                : t('agent.install.action', { version: entry.preferredVersion })}
          </Button>
        ) : null}
      </div>
      {entry.install.status === 'failed' && entry.install.error ? (
        <div className="px-4 pt-3">
          <Banner>{entry.install.error}</Banner>
        </div>
      ) : null}

      {entry.installed ? (
        <div className="divide-y divide-line px-4">
          {/* D'abord ce qui marche sans rien faire : la connexion du CLI lui-même. */}
          <Section
            icon={<TerminalSquare size={14} />}
            title={t('onboarding.agents.cli.title')}
            badge={<Badge tone={plan ? 'positive' : 'accent'}>{plan ? t('onboarding.agents.cli.connected', { plan }) : t('onboarding.agents.cli.default')}</Badge>}
          >
            {plan ? (
              t('onboarding.agents.cli.connected.hint')
            ) : (
              <>
                {t('onboarding.agents.cli.unknown.before')} <code>{CLI_LOGIN[entry.agent]}</code> {t('onboarding.agents.cli.unknown.after')}
              </>
            )}
          </Section>

          {/* Puis l'option, pour qui en a besoin. Seuls Claude et Codex ont des comptes
              supplémentaires dans Sillage. */}
          {entry.agent === 'claude' ? <ClaudeExtra cliConnected={plan !== null} /> : null}
          {entry.agent === 'codex' ? <CodexExtra cliConnected={plan !== null} /> : null}
        </div>
      ) : null}
    </Card>
  )
}

function Section({ icon, title, badge, children, actions }: { icon: ReactNode; title: string; badge?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-faint">{icon}</span>
        <span className="text-sm font-medium text-ink">{title}</span>
        {badge}
      </div>
      <p className="pl-6 text-xs leading-relaxed text-ink-faint [&_code]:rounded [&_code]:bg-sunken [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-ink">{children}</p>
      {actions ? <div className="pl-6">{actions}</div> : null}
    </div>
  )
}

/**
 * Les comptes Claude supplémentaires : ceux déjà là, et l'ajout, par la connexion guidée
 * ou un jeton collé. Quand le CLI n'a pas l'air connecté, le premier compte ajouté ici
 * devient celui des nouvelles conversations : sans ça, elles partiraient sur une
 * connexion absente. Quand le CLI l'est, le compte s'ajoute sans rien changer.
 */
function ClaudeExtra({ cliConnected }: { cliConnected: boolean }) {
  const t = useTranslate()
  const { data } = useClaudeAccounts()
  const { data: settings } = useUserSettings()
  const updateDefault = useUpdateAgentDefault()
  const [adding, setAdding] = useState(false)
  const [known, setKnown] = useState<Set<string> | null>(null)
  const accounts = data?.accounts ?? []

  // Les comptes présents à l'arrivée ne sont pas « ajoutés ici ».
  useEffect(() => {
    if (data && known === null) setKnown(new Set(data.accounts.map((account) => account.id)))
  }, [data, known])

  const defaults = settings?.agentDefaults.claude
  const firstAdded = known ? (accounts.find((account) => !known.has(account.id))?.id ?? null) : null
  useEffect(() => {
    if (cliConnected || !defaults || defaults.account !== null || !firstAdded || updateDefault.isPending) return
    updateDefault.mutate({ ...defaults, account: firstAdded })
  }, [cliConnected, defaults, firstAdded, updateDefault])

  return (
    <ExtraAccounts
      accounts={accounts.map((account) => ({ id: account.id, label: account.label, ready: true, isDefault: defaults?.account === account.id }))}
      adding={adding}
      onAdd={() => setAdding(true)}
      form={adding ? <ClaudeAddAccountCard onClose={() => setAdding(false)} /> : null}
      hint={t(cliConnected ? 'onboarding.agents.extra.hint' : 'onboarding.agents.extra.hint.noCli')}
    />
  )
}

/**
 * Même chose pour Codex : un compte supplémentaire, connecté par code d'appareil ou clé
 * API. Le compte naît avant sa connexion ; son état vient de la liste, relue pendant
 * la connexion.
 */
function CodexExtra({ cliConnected }: { cliConnected: boolean }) {
  const t = useTranslate()
  const { data } = useCodexAccounts()
  const create = useCreateCodexAccount()
  const { data: settings } = useUserSettings()
  const updateDefault = useUpdateAgentDefault()
  const [openedId, setOpenedId] = useState<string | null>(null)
  const accounts = data?.accounts ?? []
  const opened: CodexAccount | null = accounts.find((account) => account.id === openedId) ?? null

  const defaults = settings?.agentDefaults.codex
  useEffect(() => {
    if (cliConnected || !defaults || defaults.account !== null || !opened || opened.status !== 'ready' || updateDefault.isPending) return
    updateDefault.mutate({ ...defaults, account: opened.id })
  }, [cliConnected, defaults, opened, updateDefault])

  return (
    <ExtraAccounts
      accounts={accounts.map((account) => ({ id: account.id, label: account.label, ready: account.status === 'ready', isDefault: defaults?.account === account.id }))}
      adding={opened !== null}
      pending={create.isPending}
      onAdd={() => create.mutate({ label: t('onboarding.agents.codexLabel') }, { onSuccess: (account) => setOpenedId(account.id) })}
      form={opened ? <CodexLoginControls account={opened} /> : null}
      hint={t(cliConnected ? 'onboarding.agents.extra.hint' : 'onboarding.agents.extra.hint.noCli')}
    />
  )
}

function ExtraAccounts({
  accounts,
  adding,
  pending = false,
  onAdd,
  form,
  hint,
}: {
  accounts: { id: string; label: string; ready: boolean; isDefault: boolean }[]
  adding: boolean
  pending?: boolean
  onAdd: () => void
  form: ReactNode
  hint: string
}) {
  const t = useTranslate()
  return (
    <Section
      icon={<KeyRound size={14} />}
      title={t('onboarding.agents.extra.title')}
      badge={<Badge tone="neutral">{t('onboarding.agents.extra.optional')}</Badge>}
      actions={
        <div className="flex flex-col gap-2">
          {accounts.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {accounts.map((account) => (
                <li key={account.id}>
                  <Badge tone={account.isDefault ? 'accent' : account.ready ? 'positive' : 'neutral'}>
                    {account.ready ? <Check size={12} /> : <KeyRound size={12} />} {account.label}
                    {account.isDefault ? ` · ${t('onboarding.agents.defaultAccount')}` : ''}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {adding ? (
            form
          ) : (
            <div>
              <Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={pending} onClick={onAdd}>
                {t(accounts.length > 0 ? 'onboarding.agents.addAccount' : 'onboarding.agents.connect')}
              </Button>
            </div>
          )}
        </div>
      }
    >
      {hint}
    </Section>
  )
}
