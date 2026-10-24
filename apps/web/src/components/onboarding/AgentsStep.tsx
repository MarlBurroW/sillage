import { LoginControls as AntigravityLoginControls } from '../../routes/AntigravityAccountsSettingsPage'
import { Check, Download, KeyRound, Plus, TerminalSquare } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { AgentAvailabilityDto, AgentKind } from '@sillage/protocol'
import { useAgentAvailability, useAgentInstall } from '../../lib/agents'
import { useExtraAccounts, type ExtraAccountAgent } from '../../lib/extra-accounts'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { useAgentUsage } from '../../lib/usage'
import { AddAccountCard as ClaudeAddAccountCard } from '../../routes/ClaudeAccountsSettingsPage'
import { LoginControls as CodexLoginControls } from '../../routes/CodexAccountsSettingsPage'
import { LoginControls as GrokLoginControls } from '../../routes/GrokAccountsSettingsPage'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { AgentInstallProgress } from '../AgentInstallProgress'
import { Badge, Banner, Button, Card } from '../ui'
import { StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

/** How each CLI logs in from a machine terminal. */
const CLI_LOGIN: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex login',
  opencode: 'opencode auth login',
  grok: 'grok login',
  antigravity: 'Google Antigravity',
}

/** Name assigned to accounts created for onboarding login. */
const EXTRA_LABEL: Record<ExtraAccountAgent, MessageKey> = {
  claude: 'onboarding.agents.claudeLabel',
  codex: 'onboarding.agents.codexLabel',
  grok: 'onboarding.agents.grokLabel',
  antigravity: 'onboarding.agents.antigravityLabel',
}

/**
 * Agent cards show server knowledge for selected CLIs. Explain default machine CLI login first,
 * requiring nothing if already connected; additional accounts are optional subscriptions/API keys
 * and the only terminal-free login route. Logic is shared with settings and drafts; presentation is
 * tour-specific.
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

      {/* One card per CLI: headings report state, bodies contain settings. */}
      <div className="flex flex-col gap-3">
        {rows.map((entry) => (
          <AgentCard key={entry.agent} entry={entry} />
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

function AgentCard({ entry }: { entry: AgentAvailabilityDto }) {
  const t = useTranslate()
  const label = AGENT_LABELS[entry.agent]
  const install = useAgentInstall(entry, label)
  // Usage-reported plans are the strongest login evidence when available, but absence does not
  // prove disconnection.
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
        {install.offered && !install.progress ? (
          <Button size="sm" variant="secondary" icon={<Download size={14} />} disabled={install.busy} onClick={install.start}>
            {install.action}
          </Button>
        ) : null}
      </div>
      {/* Progress replaces the button: lengthy installation needs more evidence than a disabled control. */}
      {install.progress ? (
        <AgentInstallProgress label={label} version={entry.preferredVersion} progress={install.progress} className="px-4 pt-3" />
      ) : null}
      {install.failed ? (
        <div className="px-4 pt-3">
          <Banner>{install.status}</Banner>
        </div>
      ) : null}

      {entry.installed ? (
        <div className="divide-y divide-line px-4">
          {/* Start with what works automatically: the CLI's own login. */}
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

          {/*
           * Then optional accounts for those needing them. OpenCode has no Sillage accounts and
           * logs into providers through its own CLI.
           */}
          {entry.agent !== 'opencode' ? <ExtraAccounts agent={entry.agent} cliConnected={plan !== null} /> : null}
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

/** Additional accounts as badges plus settings login forms. Logic lives in useExtraAccounts. */
function ExtraAccounts({ agent, cliConnected }: { agent: ExtraAccountAgent; cliConnected: boolean }) {
  const t = useTranslate()
  const extra = useExtraAccounts(agent, { adoptAsDefault: !cliConnected, defaultLabel: t(EXTRA_LABEL[agent]) })
  // Claude creates accounts only after form completion, so opening is local.
  const [claudeAdding, setClaudeAdding] = useState(false)
  const form =
    agent === 'claude'
      ? claudeAdding
        ? <ClaudeAddAccountCard onClose={() => setClaudeAdding(false)} />
        : null
      : agent === 'codex'
        ? extra.codexOpened && <CodexLoginControls account={extra.codexOpened} />
        : extra.grokOpened ? <GrokLoginControls account={extra.grokOpened} /> : extra.antigravityOpened && <AntigravityLoginControls account={extra.antigravityOpened} />
  const add = agent === 'claude' ? () => setClaudeAdding(true) : extra.begin

  return (
    <Section
      icon={<KeyRound size={14} />}
      title={t('onboarding.agents.extra.title')}
      badge={<Badge tone="neutral">{t('onboarding.agents.extra.optional')}</Badge>}
      actions={
        <div className="flex flex-col gap-2">
          {extra.accounts.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {extra.accounts.map((account) => (
                <li key={account.id}>
                  <Badge tone={account.isDefault ? 'accent' : account.ready ? 'positive' : 'neutral'}>
                    {account.ready ? <Check size={12} /> : <KeyRound size={12} />} {account.label}
                    {account.isDefault ? ` · ${t('onboarding.agents.defaultAccount')}` : ''}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {form ? (
            form
          ) : (
            <div>
              <Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={extra.creating} onClick={add}>
                {t(extra.accounts.length > 0 ? 'onboarding.agents.addAccount' : 'onboarding.agents.connect')}
              </Button>
            </div>
          )}
        </div>
      }
    >
      {t(cliConnected ? 'onboarding.agents.extra.hint' : 'onboarding.agents.extra.hint.noCli')}
    </Section>
  )
}
