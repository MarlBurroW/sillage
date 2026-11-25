import { FolderGit2, Laptop, Smartphone, TerminalSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import { agentKindSchema } from '@sillage/protocol'
import { useAgentAvailability } from '../../lib/agents'
import { useLocale, useTranslate } from '../../lib/i18n'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { StepTitle, Tip, useCommit, useGate, type StepProps } from './shell'

/**
 * Welcome says what Sillage is before anything is asked. It used to open with a questionnaire;
 * every answer was either readable from the machine or better asked on the step it shaped, so this
 * screen now only sets the model: official CLIs, projects as folders, work followed from anywhere.
 */
export function WelcomeStep({ nav, profile, user }: StepProps) {
  const t = useTranslate()
  const locale = useLocale()
  const { data: availability } = useAgentAvailability()
  // Named from what this instance offers, so the sentence never falls behind the list of CLIs.
  const offered = availability ? availability.agents.filter((entry) => entry.enabled).map((entry) => entry.agent) : agentKindSchema.options
  const names = new Intl.ListFormat(locale, { type: 'conjunction' }).format(offered.map((agent) => AGENT_LABELS[agent]))
  const host = t(profile === 'desktop' ? 'onboarding.host.computer' : 'onboarding.host.server')

  useGate(nav, { canContinue: true, laterAllowed: false, skipAllowed: true })
  useCommit(nav, null)

  return (
    <>
      <StepTitle
        title={user ? t('onboarding.welcome.title', { name: user.displayName }) : t('onboarding.welcome.title.anonymous')}
        lead={t('onboarding.welcome.lead', { host })}
      />

      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        <Pillar
          icon={<TerminalSquare size={18} />}
          title={t('onboarding.welcome.cli.title')}
          body={t('onboarding.welcome.cli.body', { names })}
          extra={
            <span className="mt-2 flex flex-wrap gap-1.5" aria-hidden>
              {offered.map((agent) => (
                <span key={agent} className="grid size-7 place-items-center rounded-md bg-surface-high">
                  <AgentIcon agent={agent} size={15} />
                </span>
              ))}
            </span>
          }
        />
        <Pillar icon={<FolderGit2 size={18} />} title={t('onboarding.welcome.project.title')} body={t('onboarding.welcome.project.body', { host })} />
        {profile === 'desktop' ? (
          <Pillar icon={<Laptop size={18} />} title={t('onboarding.welcome.local.title')} body={t('onboarding.welcome.local.body')} />
        ) : (
          <Pillar icon={<Smartphone size={18} />} title={t('onboarding.welcome.anywhere.title')} body={t('onboarding.welcome.anywhere.body')} />
        )}
      </ul>

      <Tip>{t('onboarding.welcome.tour')}</Tip>
    </>
  )
}

function Pillar({ icon, title, body, extra }: { icon: ReactNode; title: string; body: string; extra?: ReactNode }) {
  return (
    <li className="flex gap-3.5 px-4 py-4">
      <span className="gradient-accent grid size-9 shrink-0 place-items-center rounded-lg text-accent-ink">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block text-sm leading-relaxed text-ink-soft">{body}</span>
        {extra}
      </span>
    </li>
  )
}
