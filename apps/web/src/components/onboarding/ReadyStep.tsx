import { Bot, Circle, CircleCheck, Clock, Eye, FileText, FolderOpen, Globe, Layers, MessageSquare, PanelRight, ShieldCheck, Smartphone, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAgentAvailability } from '../../lib/agents'
import { useAppSettings } from '../../lib/app-settings'
import { useAppearance } from '../../lib/appearance'
import { useTranslate } from '../../lib/i18n'
import { useGlobalInstructions } from '../../lib/instructions'
import { currentOrigin, describeOrigin, onboardingSteps } from '../../lib/onboarding'
import { useProjects } from '../../lib/projects'
import { THEME_LABELS, useTheme } from '../../lib/theme'
import { AGENT_LABELS } from '../AgentIcon'
import { Question, StepTitle, useCommit, useGate, type StepProps } from './shell'

/** Le récapitulatif : ce que chaque étape a laissé, lu dans les vraies données. */
export function ReadyStep({ nav, state, user, profile }: StepProps) {
  const t = useTranslate()
  const admin = user?.isAdmin ?? false
  const steps = onboardingSteps({ profile, isAdmin: admin, answers: state.answers })
  const { data: projects } = useProjects()
  const { data: availability } = useAgentAvailability()
  const { data: appSettings } = useAppSettings()
  const { data: instructions } = useGlobalInstructions()
  const [theme] = useTheme()
  const appearance = useAppearance()

  useGate(nav, { canContinue: true, laterAllowed: false, skipAllowed: false })
  useCommit(nav, null)

  const skipped = (id: string) => state.skipped.includes(id)
  const project = projects?.find((entry) => entry.id === state.projectId) ?? null
  const chosenAgents = state.answers.agents.length > 0 ? state.answers.agents : (['claude'] as const)
  const agentsLine = chosenAgents
    .map((agent) => {
      const entry = availability?.agents.find((candidate) => candidate.agent === agent)
      return `${AGENT_LABELS[agent]}${entry?.installed ? '' : ` · ${t('onboarding.ready.agents.toInstall')}`}`
    })
    .join(' · ')
  const tint = appearance.values.tint
  const ambiance = t(tint === 0 ? 'appearance.presets.neutral' : tint <= 0.25 ? 'appearance.presets.soft' : 'appearance.presets.sillage')
  const permission = t(`onboarding.work.permission.${state.answers.permission}` as const)
  const publicUrl = appSettings?.publicUrl || currentOrigin()
  const origin = describeOrigin(publicUrl)

  const items: { id: string; icon: ReactNode; title: string; detail: string; done: boolean }[] = []
  if (steps.includes('account') && user) {
    items.push({
      id: 'account',
      icon: <UserRound size={16} />,
      title: t('onboarding.ready.account'),
      detail: `${user.displayName} · ${t(user.isAdmin ? 'users.role.admin.label' : 'users.role.member.label')}`,
      done: true,
    })
  }
  items.push({
    id: 'appearance',
    icon: <Eye size={16} />,
    title: t('onboarding.ready.appearance'),
    detail: `${t(THEME_LABELS[theme])} · ${ambiance}`,
    done: !skipped('appearance'),
  })
  items.push({ id: 'agents', icon: <Bot size={16} />, title: t('onboarding.ready.agents'), detail: agentsLine, done: !skipped('agents') })
  items.push({
    id: 'project',
    icon: <FolderOpen size={16} />,
    title: t('onboarding.ready.project'),
    detail: project ? `${project.name} · ${project.workspacePath}` : t('onboarding.ready.project.none'),
    done: project !== null,
  })
  items.push({
    id: 'work',
    icon: <ShieldCheck size={16} />,
    title: t('onboarding.ready.work'),
    detail: skipped('work') ? t('onboarding.ready.work.default') : `${permission}${project?.turnCheckpoints ? ` · ${t('onboarding.ready.work.checkpoints')}` : ''}`,
    done: !skipped('work'),
  })
  if (steps.includes('rules')) {
    const lines = (instructions?.content ?? '').split('\n').filter((line) => line.trim().length > 0).length
    items.push({
      id: 'rules',
      icon: <FileText size={16} />,
      title: t('onboarding.ready.rules'),
      detail: lines > 0 ? t('onboarding.ready.rules.lines', { count: lines }) : t('onboarding.ready.rules.none'),
      done: lines > 0,
    })
  }
  if (steps.includes('address')) {
    items.push(
      admin
        ? {
            id: 'address',
            icon: <Globe size={16} />,
            title: t('onboarding.ready.address'),
            detail: skipped('address') ? t('onboarding.ready.address.later') : `${publicUrl}${origin.local ? ` · ${t('onboarding.address.local')}` : ''}`,
            done: !skipped('address') && origin.valid && !origin.local,
          }
        : {
            id: 'address',
            icon: <Smartphone size={16} />,
            title: t('onboarding.ready.phone'),
            detail: skipped('address') ? t('onboarding.ready.phone.later') : publicUrl,
            done: !skipped('address'),
          },
    )
  }

  const next: { icon: ReactNode; text: string }[] = [
    { icon: <MessageSquare size={15} />, text: t('onboarding.ready.next.message') },
    { icon: <PanelRight size={15} />, text: t('onboarding.ready.next.panel') },
    { icon: <Layers size={15} />, text: t('onboarding.ready.next.skills') },
    { icon: <Clock size={15} />, text: t('onboarding.ready.next.schedule') },
  ]

  return (
    <>
      <StepTitle title={t('onboarding.ready.title')} lead={t('onboarding.ready.lead')} />
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5">
            <span className={item.done ? 'mt-0.5 text-positive' : 'mt-0.5 text-ink-faint'}>
              {item.done ? <CircleCheck size={16} /> : <Circle size={16} />}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                {item.icon} {item.title}
              </span>
              <span className="mt-0.5 block break-words text-xs text-ink-faint">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <Question label={t('onboarding.ready.next')} hint={t('onboarding.ready.next.hint')}>
        <ul className="grid gap-2 sm:grid-cols-2">
          {next.map((entry) => (
            <li key={entry.text} className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink-soft">
              <span className="mt-0.5 shrink-0 text-accent">{entry.icon}</span>
              {entry.text}
            </li>
          ))}
        </ul>
      </Question>
    </>
  )
}
