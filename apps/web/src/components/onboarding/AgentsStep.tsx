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

/** Comment chaque CLI se connecte lui-même, depuis un terminal de la machine. */
const CLI_LOGIN: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex login',
  opencode: 'opencode auth login',
  grok: 'grok login',
}

/** Le nom donné au compte que la visite crée pour le connecter. */
const EXTRA_LABEL: Record<ExtraAccountAgent, MessageKey> = {
  claude: 'onboarding.agents.claudeLabel',
  codex: 'onboarding.agents.codexLabel',
  grok: 'onboarding.agents.grokLabel',
}

/**
 * Tes agents : une carte par CLI retenu, avec ce que le serveur en sait.
 *
 * Deux choses à faire comprendre, dans cet ordre : par défaut, une conversation part sur
 * la connexion que le CLI garde lui-même sur la machine, et il n'y a rien à faire si
 * elle existe ; les comptes supplémentaires sont une option, pour un autre abonnement
 * ou une clé API, et le seul chemin de connexion sans terminal. La logique vient des
 * bibliothèques partagées avec les réglages et la page de brouillon ; seule la mise en
 * forme est propre à la visite.
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
        {install.offered && !install.progress ? (
          <Button size="sm" variant="secondary" icon={<Download size={14} />} disabled={install.busy} onClick={install.start}>
            {install.action}
          </Button>
        ) : null}
      </div>
      {/* Le bouton laisse la place à l'avancement : une installation dure plusieurs
          minutes, et un bouton grisé ne dit pas si quelque chose se passe. */}
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

          {/* Puis l'option, pour qui en a besoin. OpenCode n'a pas de comptes dans Sillage :
              il se connecte fournisseur par fournisseur depuis son propre CLI. */}
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

/**
 * Les comptes supplémentaires d'un CLI : ceux qui existent, en badges, et l'ajout avec le
 * formulaire de connexion des réglages. La logique est dans `useExtraAccounts`.
 */
function ExtraAccounts({ agent, cliConnected }: { agent: ExtraAccountAgent; cliConnected: boolean }) {
  const t = useTranslate()
  const extra = useExtraAccounts(agent, { adoptAsDefault: !cliConnected, defaultLabel: t(EXTRA_LABEL[agent]) })
  // Claude ne crée le compte qu'à la fin de son formulaire : son ouverture est locale.
  const [claudeAdding, setClaudeAdding] = useState(false)
  const form =
    agent === 'claude'
      ? claudeAdding
        ? <ClaudeAddAccountCard onClose={() => setClaudeAdding(false)} />
        : null
      : agent === 'codex'
        ? extra.codexOpened && <CodexLoginControls account={extra.codexOpened} />
        : extra.grokOpened && <GrokLoginControls account={extra.grokOpened} />
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
