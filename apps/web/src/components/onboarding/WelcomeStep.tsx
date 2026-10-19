import { GraduationCap, Monitor, Smartphone, Sparkles, UserRound, UsersRound, Zap } from 'lucide-react'
import { useEffect } from 'react'
import type { AgentKind } from '@sillage/protocol'
import { useAgentAvailability } from '../../lib/agents'
import { useTranslate } from '../../lib/i18n'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { CardGrid, ChoiceCard, Question, StepTitle, useCommit, useGate, type StepProps } from './shell'

const ALL_AGENTS: AgentKind[] = ['claude', 'codex', 'opencode', 'grok']

/**
 * Bienvenue : ce que Sillage est, en trois lignes, puis les questions qui décident de
 * la suite. Les réponses partent au compte à chaque clic : la liste des étapes, à
 * gauche, suit sans attendre.
 */
export function WelcomeStep({ nav, state, setAnswers, profile, user }: StepProps) {
  const t = useTranslate()
  const { data: availability } = useAgentAvailability()
  // Un CLI coupé dans la configuration n'a rien à faire dans la question.
  const offered = availability ? availability.agents.filter((entry) => entry.enabled).map((entry) => entry.agent) : ALL_AGENTS
  const installed = availability ? availability.agents.filter((entry) => entry.enabled && entry.installed).map((entry) => entry.agent) : []
  const answers = state.answers

  useGate(nav, { canContinue: true, laterAllowed: false, skipAllowed: true })
  useCommit(nav, null)

  // Tant qu'on n'a pas répondu, ce que la machine porte déjà vaut réponse : un CLI
  // installé sur le serveur est un CLI dont on se sert.
  const agentsEmpty = answers.agents.length === 0
  const agentsChosen = answers.agentsChosen
  const installedKey = installed.join(',')
  useEffect(() => {
    if (agentsChosen || !agentsEmpty || installedKey === '') return
    setAnswers({ agents: installedKey.split(',') as AgentKind[] })
    // `setAnswers` change à chaque rendu : la liste des installés suffit à décider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsChosen, agentsEmpty, installedKey])

  const toggleAgent = (agent: AgentKind) =>
    setAnswers({
      agentsChosen: true,
      agents: answers.agents.includes(agent) ? answers.agents.filter((entry) => entry !== agent) : [...answers.agents, agent],
    })

  const host = t(profile === 'desktop' ? 'onboarding.host.computer' : 'onboarding.host.server')

  return (
    <>
      <StepTitle
        title={user ? t('onboarding.welcome.title', { name: user.displayName }) : t('onboarding.welcome.title.anonymous')}
        lead={
          <>
            {t('onboarding.welcome.lead', { host })}
            <br />
            {t('onboarding.welcome.lead.more')}
          </>
        }
      />

      <Question label={t('onboarding.welcome.agents')} hint={t('onboarding.welcome.agents.hint')}>
        <div className="flex flex-wrap gap-2">
          {offered.map((agent) => (
            <ChoiceCard
              key={agent}
              multi
              compact
              selected={answers.agents.includes(agent)}
              onClick={() => toggleAgent(agent)}
              icon={<AgentIcon agent={agent} size={16} />}
              label={AGENT_LABELS[agent]}
              hint={installed.includes(agent) ? t('onboarding.welcome.agents.installed') : undefined}
            />
          ))}
          <ChoiceCard
            multi
            compact
            selected={answers.agents.length === 0}
            onClick={() => setAnswers({ agents: [], agentsChosen: true })}
            icon={<Sparkles size={15} />}
            label={t('onboarding.welcome.agents.none')}
          />
        </div>
      </Question>

      {profile === 'server' && user?.isAdmin ? (
        <Question label={t('onboarding.welcome.team')}>
          <CardGrid>
            <ChoiceCard
              selected={answers.team === 'solo'}
              onClick={() => setAnswers({ team: 'solo' })}
              icon={<UserRound size={15} />}
              label={t('onboarding.welcome.team.solo')}
              hint={t('onboarding.welcome.team.solo.hint')}
            />
            <ChoiceCard
              selected={answers.team === 'team'}
              onClick={() => setAnswers({ team: 'team' })}
              icon={<UsersRound size={15} />}
              label={t('onboarding.welcome.team.team')}
              hint={t('onboarding.welcome.team.team.hint')}
            />
          </CardGrid>
        </Question>
      ) : null}

      {profile === 'server' ? (
        <Question label={t('onboarding.welcome.devices')}>
          <CardGrid>
            <ChoiceCard
              selected={answers.devices === 'computer'}
              onClick={() => setAnswers({ devices: 'computer' })}
              icon={<Monitor size={15} />}
              label={t('onboarding.welcome.devices.computer')}
              hint={t('onboarding.welcome.devices.computer.hint')}
            />
            <ChoiceCard
              selected={answers.devices === 'phone'}
              onClick={() => setAnswers({ devices: 'phone' })}
              icon={<Smartphone size={15} />}
              label={t('onboarding.welcome.devices.phone')}
              hint={t('onboarding.welcome.devices.phone.hint')}
            />
          </CardGrid>
        </Question>
      ) : null}

      <Question label={t('onboarding.welcome.guidance')}>
        <CardGrid>
          <ChoiceCard
            selected={answers.guidance === 'guided'}
            onClick={() => setAnswers({ guidance: 'guided' })}
            icon={<GraduationCap size={15} />}
            label={t('onboarding.welcome.guidance.guided')}
            hint={t('onboarding.welcome.guidance.guided.hint')}
          />
          <ChoiceCard
            selected={answers.guidance === 'direct'}
            onClick={() => setAnswers({ guidance: 'direct' })}
            icon={<Zap size={15} />}
            label={t('onboarding.welcome.guidance.direct')}
            hint={t('onboarding.welcome.guidance.direct.hint')}
          />
        </CardGrid>
      </Question>
    </>
  )
}
