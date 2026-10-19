import { FileText, Shield, ShieldCheck, Zap } from 'lucide-react'
import { useState } from 'react'
import type { AgentKind } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { withPermissionChoice, type PermissionChoice } from '../../lib/onboarding'
import { useProjects, useUpdateProject } from '../../lib/projects'
import { useUpdateAgentDefault, useUserSettings } from '../../lib/user-settings'
import { Banner, Switch } from '../ui'
import { CardGrid, ChoiceCard, Question, StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

const ALL_AGENTS: AgentKind[] = ['claude', 'codex', 'opencode', 'grok']

/**
 * Comment l'agent travaille : le réflexe de permission, écrit dans les défauts de
 * chaque CLI retenu à « Continuer », et les points de reprise du projet créé.
 */
export function WorkStep({ nav, state, setAnswers }: StepProps) {
  const t = useTranslate()
  const { data: settings } = useUserSettings()
  const updateDefault = useUpdateAgentDefault()
  const { data: projects } = useProjects()
  const updateProject = useUpdateProject()

  const project = projects?.find((entry) => entry.id === state.projectId) ?? null
  // Null tant qu'on n'y a pas touché : l'interrupteur montre alors ce que le projet dit.
  const [checkpoints, setCheckpoints] = useState<boolean | null>(null)
  const effectiveCheckpoints = checkpoints ?? project?.turnCheckpoints ?? true
  const choice = state.answers.permission

  useGate(nav, { canContinue: true, laterAllowed: true, skipAllowed: true })
  useCommit(nav, async () => {
    if (settings) {
      const agents = state.answers.agents.length > 0 ? state.answers.agents : ALL_AGENTS
      for (const agent of agents) {
        await updateDefault.mutateAsync(withPermissionChoice(settings.agentDefaults[agent], choice))
      }
    }
    if (project && checkpoints !== null && checkpoints !== project.turnCheckpoints) {
      await updateProject.mutateAsync({ id: project.id, turnCheckpoints: checkpoints })
    }
  })

  const options: { value: PermissionChoice; icon: React.ReactNode; label: string; hint: string }[] = [
    { value: 'manual', icon: <Shield size={15} />, label: t('onboarding.work.permission.manual'), hint: t('onboarding.work.permission.manual.hint') },
    { value: 'auto', icon: <ShieldCheck size={15} />, label: t('onboarding.work.permission.auto'), hint: t('onboarding.work.permission.auto.hint') },
    { value: 'acceptEdits', icon: <FileText size={15} />, label: t('onboarding.work.permission.acceptEdits'), hint: t('onboarding.work.permission.acceptEdits.hint') },
    { value: 'bypass', icon: <Zap size={15} />, label: t('onboarding.work.permission.bypass'), hint: t('onboarding.work.permission.bypass.hint') },
  ]

  return (
    <>
      <StepTitle title={t('onboarding.work.title')} lead={t('onboarding.work.lead')} />

      <Question label={t('onboarding.work.permission')} hint={t('onboarding.work.permission.hint')}>
        <CardGrid>
          {options.map((option) => (
            <ChoiceCard
              key={option.value}
              selected={choice === option.value}
              onClick={() => setAnswers({ permission: option.value })}
              icon={option.icon}
              label={option.label}
              hint={option.hint}
            />
          ))}
        </CardGrid>
        {choice === 'bypass' ? <Banner tone="info">{t('onboarding.work.permission.bypass.warning')}</Banner> : null}
        <Tip>{t('onboarding.work.permission.scope')}</Tip>
      </Question>

      <div className="flex items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{t('project.settings.checkpoints')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
            {project ? t('onboarding.work.checkpoints.hint') : t('onboarding.work.checkpoints.noProject')}
          </p>
        </div>
        <Switch
          checked={effectiveCheckpoints}
          disabled={!project}
          label={t('project.settings.checkpoints')}
          onCheckedChange={setCheckpoints}
        />
      </div>

      {state.answers.guidance === 'guided' ? (
        <Why>
          <b>{t('onboarding.work.why.title')}</b> {t('onboarding.work.why.body')}
        </Why>
      ) : null}
    </>
  )
}
