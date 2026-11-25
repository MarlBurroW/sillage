import { LoginControls as AntigravityLoginControls } from '../../routes/AntigravityAccountsSettingsPage'
import { Check, ChevronDown, Download, KeyRound, Loader, Plus, TerminalSquare } from 'lucide-react'
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
import { Badge, Banner, Button, Card, cx } from '../ui'
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
 * One line per CLI this instance offers, installed ones first. A line states what the machine
 * already knows (installed, signed in) and opens onto the sign-in details only when something is
 * left to do: the common case, a CLI already signed in, reads as done at a glance. Logic is shared
 * with settings and drafts; presentation is tour-specific.
 */
export function AgentsStep({ nav, profile, isAdmin }: StepProps) {
  const t = useTranslate()
  const { data: availability } = useAgentAvailability()
  const offered = (availability?.agents ?? []).filter((entry) => entry.enabled)
  const rows = [...offered.filter((entry) => entry.installed), ...offered.filter((entry) => !entry.installed)]
  const none = availability !== undefined && !offered.some((entry) => entry.installed)

  useGate(nav, { canContinue: true, laterAllowed: true, skipAllowed: true })
  useCommit(nav, null)

  return (
    <>
      <StepTitle
        title={t('onboarding.agents.title')}
        lead={t('onboarding.agents.lead', { host: t(profile === 'desktop' ? 'onboarding.host.computer' : 'onboarding.host.server') })}
      />

      {none ? (
        <Why>
          <b>{t('onboarding.agents.beginner.title')}</b> {t(isAdmin ? 'onboarding.agents.beginner.body' : 'onboarding.agents.beginner.member')}
        </Why>
      ) : null}

      <div className="flex flex-col gap-2">
        {rows.map((entry) => (
          <AgentRow key={entry.agent} entry={entry} />
        ))}
        {availability && rows.length === 0 ? <p className="text-sm text-ink-faint">{t('onboarding.agents.none')}</p> : null}
      </div>

      <Tip>{t('onboarding.agents.more')}</Tip>
    </>
  )
}

function AgentRow({ entry }: { entry: AgentAvailabilityDto }) {
  const t = useTranslate()
  const label = AGENT_LABELS[entry.agent]
  const install = useAgentInstall(entry, label)
  // Usage-reported plans are the strongest login evidence when available, but absence does not
  // prove disconnection.
  const usage = useAgentUsage(entry.agent, entry.installed)
  const plan = usage.data?.plan ?? null
  const checking = entry.installed && usage.isPending
  // OpenCode has no Sillage accounts: it logs into its providers through its own CLI, so the
  // sign-in sentence must not point at an account section that is not there.
  const hasAccounts = entry.agent !== 'opencode'
  // Open by itself only when the sign-in could not be confirmed; a click decides afterwards.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = entry.installed && (chosen ?? (!checking && plan === null))

  const status = !entry.installed ? (
    <Badge tone="neutral">{entry.reason === 'disabled' ? t('agent.unavailable.disabled') : t('onboarding.agents.missing')}</Badge>
  ) : checking ? (
    <Badge tone="neutral" icon={<Loader size={12} className="animate-spin" />}>{t('onboarding.agents.checking')}</Badge>
  ) : plan ? (
    <Badge tone="positive" icon={<Check size={12} />}>{t('onboarding.agents.cli.connected', { plan })}</Badge>
  ) : (
    <Badge tone="accent">{t('onboarding.agents.cli.unknown')}</Badge>
  )

  // A basis rather than a bare flex-1: on a phone the install button drops under the name instead
  // of squeezing it onto three lines.
  const head = (
    <span className="flex min-w-0 flex-1 basis-48 items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-high">
        <AgentIcon agent={entry.agent} size={20} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="block text-xs text-ink-faint">
          {entry.installed ? t('onboarding.agents.installed', { version: entry.version ?? '' }) : t(`onboarding.agents.about.${entry.agent}` as MessageKey)}
        </span>
      </span>
    </span>
  )

  return (
    <Card>
      {entry.installed ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setChosen(!open)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          {head}
          {status}
          <ChevronDown size={16} className={cx('shrink-0 text-ink-faint transition-transform', open ? 'rotate-180' : '')} aria-hidden />
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          {head}
          {install.offered && !install.progress ? (
            <Button size="sm" variant="secondary" icon={<Download size={14} />} disabled={install.busy} onClick={install.start}>
              {install.action}
            </Button>
          ) : (
            status
          )}
        </div>
      )}
      {/* Progress replaces the button: lengthy installation needs more evidence than a disabled control. */}
      {install.progress ? (
        <AgentInstallProgress label={label} version={entry.preferredVersion} progress={install.progress} className="px-4 pb-3" />
      ) : null}
      {install.queued ? <p role="status" className="px-4 pb-3 text-sm text-ink-soft">{install.status}</p> : null}
      {install.failed ? (
        <div className="px-4 pb-3">
          <Banner>{install.status}</Banner>
        </div>
      ) : null}

      {open ? (
        <div className="divide-y divide-line border-t border-line px-4">
          {/* Start with what works automatically: the CLI's own login. */}
          <Section icon={<TerminalSquare size={14} />} title={t('onboarding.agents.cli.title')}>
            {plan ? (
              t('onboarding.agents.cli.connected.hint')
            ) : (
              <>
                {t('onboarding.agents.cli.unknown.before')} <code>{CLI_LOGIN[entry.agent]}</code>{' '}
                {t(hasAccounts ? 'onboarding.agents.cli.unknown.after' : 'onboarding.agents.cli.unknown.after.alone')}
              </>
            )}
          </Section>

          {/* Then optional accounts for those needing them. */}
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
