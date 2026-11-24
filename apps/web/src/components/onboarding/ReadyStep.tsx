import { Activity, Bot, Clock, Command, Eye, FileText, FlaskConical, Globe, Layers, MessageSquare, PanelRight, Pencil, Radio, ShieldCheck, Smartphone, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAgentAvailability } from '../../lib/agents'
import { useAppSettings } from '../../lib/app-settings'
import { useAppearance } from '../../lib/appearance'
import { useTranslate } from '../../lib/i18n'
import { useGlobalInstructions } from '../../lib/instructions'
import { currentOrigin, describeOrigin, type OnboardingStepId } from '../../lib/onboarding'
import { useRemoteAccess } from '../../lib/remote-access'
import { THEME_LABELS, useTheme } from '../../lib/theme'
import { useProjectDefaults } from '../../lib/user-settings'
import { AGENT_LABELS } from '../AgentIcon'
import { Badge, Button } from '../ui'
import { Question, StepTitle, useCommit, useGate, type StepProps } from './shell'

interface RecapItem {
  id: OnboardingStepId
  icon: ReactNode
  title: string
  detail: string
  /** False when the step was put off or left something to do: the line says so and offers it. */
  done: boolean
}

/**
 * The tour's last screen: what was set, read back from where each step saved it, with a way back
 * to any line; then what to do next. With no project yet, the next thing is a project, and the
 * sample one is offered here for whoever has no repository at hand.
 */
export function ReadyStep({ nav, state, user, isAdmin, steps, goto, finish, noProject }: StepProps) {
  const t = useTranslate()
  // The route exists on Desktop only: ask where the step is offered.
  const { data: remote } = useRemoteAccess(steps.includes('remote'))
  const { data: availability } = useAgentAvailability()
  const { data: appSettings } = useAppSettings()
  const { data: instructions } = useGlobalInstructions()
  const [theme] = useTheme()
  const appearance = useAppearance()
  const projectDefaults = useProjectDefaults()

  useGate(nav, { canContinue: true, laterAllowed: false, skipAllowed: false })
  useCommit(nav, null)

  const skipped = (id: OnboardingStepId) => state.skipped.includes(id)
  const installed = (availability?.agents ?? []).filter((entry) => entry.enabled && entry.installed).map((entry) => AGENT_LABELS[entry.agent])
  const tint = appearance.values.tint
  const ambiance = t(tint === 0 ? 'appearance.presets.neutral' : tint <= 0.25 ? 'appearance.presets.soft' : 'appearance.presets.sillage')
  const permission = t(`onboarding.work.permission.${state.answers.permission}` as const)
  const publicUrl = appSettings?.publicUrl || currentOrigin()
  const origin = describeOrigin(publicUrl)
  const lines = (instructions?.content ?? '').split('\n').filter((line) => line.trim().length > 0).length
  const storage = `${t(`onboarding.memory.instructions.${projectDefaults.instructionsMode}` as const)} · ${t(`onboarding.memory.memory.${projectDefaults.memoryMode}` as const)}`

  const items: RecapItem[] = []
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
  items.push({
    id: 'agents',
    icon: <Bot size={16} />,
    title: t('onboarding.ready.agents'),
    detail: installed.length > 0 ? installed.join(' · ') : t('onboarding.ready.agents.none'),
    done: installed.length > 0,
  })
  items.push({
    id: 'work',
    icon: <ShieldCheck size={16} />,
    title: t('onboarding.ready.work'),
    detail: skipped('work') ? t('onboarding.ready.work.default') : permission,
    done: !skipped('work'),
  })
  items.push({
    id: 'rules',
    icon: <FileText size={16} />,
    title: t('onboarding.ready.rules'),
    detail: isAdmin ? `${lines > 0 ? t('onboarding.ready.rules.lines', { count: lines }) : t('onboarding.ready.rules.none')} · ${storage}` : storage,
    // Writing no instruction is a fine answer: only putting the step off leaves it to do.
    done: !skipped('rules'),
  })
  if (steps.includes('address')) {
    items.push(
      isAdmin
        ? {
            id: 'address',
            icon: <Globe size={16} />,
            title: t('onboarding.ready.address'),
            detail: `${publicUrl}${origin.local ? ` · ${t('onboarding.address.local')}` : ''}`,
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

  if (steps.includes('remote')) {
    items.push({
      id: 'remote',
      icon: <Radio size={16} />,
      title: t('onboarding.ready.remote'),
      detail: remote?.enabled && remote.url ? remote.url : t('onboarding.ready.remote.off'),
      // Staying on this computer alone is a fine answer: only putting the step off leaves it to do.
      done: !skipped('remote'),
    })
  }

  const next: { icon: ReactNode; text: string }[] = [
    { icon: <MessageSquare size={15} />, text: t('onboarding.ready.next.message') },
    { icon: <PanelRight size={15} />, text: t('onboarding.ready.next.panel') },
    { icon: <Activity size={15} />, text: t('onboarding.ready.next.activity') },
    { icon: <Layers size={15} />, text: t('onboarding.ready.next.skills') },
    { icon: <Clock size={15} />, text: t('onboarding.ready.next.schedule') },
    { icon: <Command size={15} />, text: t('onboarding.ready.next.palette') },
  ]

  return (
    <>
      <StepTitle title={t('onboarding.ready.title')} lead={t(noProject ? 'onboarding.ready.lead.noProject' : 'onboarding.ready.lead')} />

      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
            <span className={item.done ? 'text-positive' : 'text-ink-faint'}>{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-ink">
                {item.title}
                {item.done ? null : <Badge tone="neutral">{t('onboarding.ready.todo')}</Badge>}
              </span>
              <span className="block break-words text-xs text-ink-faint">{item.detail}</span>
            </span>
            <Button variant="ghost" size="sm" icon={<Pencil size={13} />} aria-label={t('onboarding.ready.edit.named', { title: item.title })} onClick={() => goto(item.id)}>
              <span className="hidden sm:inline">{t('onboarding.ready.edit')}</span>
            </Button>
          </li>
        ))}
      </ul>

      {noProject ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent-wash/40 px-4 py-3.5">
          <span className="gradient-accent grid size-9 shrink-0 place-items-center rounded-lg text-accent-ink">
            <FlaskConical size={18} />
          </span>
          <span className="min-w-48 flex-1">
            <span className="block text-sm font-semibold text-ink">{t('onboarding.ready.sample.title')}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-soft">{t('onboarding.ready.sample.body')}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => finish('sample')}>
            {t('onboarding.ready.sample.action')}
          </Button>
        </div>
      ) : null}

      <Question label={t('onboarding.ready.next')} hint={t('onboarding.ready.next.hint')}>
        <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {next.map((entry) => (
            <li key={entry.text} className="flex items-start gap-2 text-sm leading-snug text-ink-soft">
              <span className="mt-0.5 shrink-0 text-accent">{entry.icon}</span>
              {entry.text}
            </li>
          ))}
        </ul>
      </Question>
    </>
  )
}
