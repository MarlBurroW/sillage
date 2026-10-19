import { ChevronDown, ChevronRight, FileText, History, Shield, ShieldAlert, ShieldCheck, SlidersHorizontal, Zap } from 'lucide-react'
import { useState } from 'react'
import type { AgentConfig, AgentKind } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { withPermissionChoice, type PermissionChoice } from '../../lib/onboarding'
import { useUpdateAgentDefault, useUserSettings } from '../../lib/user-settings'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useAgentSettings } from '../chat/agent-settings'
import type { SettingGroup } from '../chat/ComposerSettings'
import { Banner, Card, Select, cx } from '../ui'
import { CardGrid, ChoiceCard, Question, StepTitle, Tip, useCommit, useGate, type StepProps } from './shell'

const ALL_AGENTS: AgentKind[] = ['claude', 'codex', 'opencode', 'grok']

/** Les catégories qui comptent ici : le modèle et son effort, les garde-fous, le budget. */
const DETAIL_KEYS = ['model', 'effort', 'approval', 'sandbox', 'budget']
const isDetailGroup = (group: SettingGroup) => DETAIL_KEYS.includes(group.key) || group.key.startsWith('permission')

/**
 * Comment l'agent travaille : le réflexe de permission, écrit aussitôt dans les défauts
 * de chaque CLI retenu, et, replié dessous, les mêmes réglages que la page des défauts,
 * CLI par CLI, pour qui veut aller plus loin. Les points de reprise se règlent par
 * projet, et la visite n'en crée pas : elle dit seulement qu'ils existent d'office.
 */
export function WorkStep({ nav, state, setAnswers }: StepProps) {
  const t = useTranslate()
  const { data: settings } = useUserSettings()
  const updateDefault = useUpdateAgentDefault()
  const [detailed, setDetailed] = useState(false)
  const agents = state.answers.agents.length > 0 ? state.answers.agents : ALL_AGENTS
  const choice = state.answers.permission

  useGate(nav, { canContinue: true, laterAllowed: true, skipAllowed: true })
  useCommit(nav, null)

  // Appliqué au clic, pas à « Continuer » : le volet détaillé lit les défauts du compte,
  // et doit voir le choix rapide dès qu'il est fait.
  const choose = (next: PermissionChoice) => {
    setAnswers({ permission: next })
    if (!settings) return
    for (const agent of agents) updateDefault.mutate(withPermissionChoice(settings.agentDefaults[agent], next))
  }

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
              onClick={() => choose(option.value)}
              icon={option.icon}
              label={option.label}
              hint={option.hint}
            />
          ))}
        </CardGrid>
        {choice === 'bypass' ? <Banner tone="info">{t('onboarding.work.permission.bypass.warning')}</Banner> : null}
      </Question>

      {/* Replié, mais en pleine largeur : le choix rapide suffit à la plupart, et les
          cartes sondent chaque CLI ; le volet doit pourtant se voir de qui en a besoin. */}
      <div className="flex flex-col gap-3">
        <button
          type="button"
          aria-expanded={detailed}
          onClick={() => setDetailed((open) => !open)}
          className={cx(
            'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
            detailed ? 'border-accent bg-accent-wash' : 'border-line bg-surface hover:border-line-strong',
          )}
        >
          <span className={cx('grid size-8 shrink-0 place-items-center rounded-md bg-surface-high', detailed ? 'text-accent' : 'text-ink-soft')}>
            <SlidersHorizontal size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">{t('onboarding.work.detail.toggle')}</span>
            <span className="mt-0.5 block text-xs leading-snug text-ink-faint">{t('onboarding.work.detail.hint')}</span>
          </span>
          <span className="shrink-0 text-ink-faint">{detailed ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
        </button>
        {detailed ? (
          <>
            <Tip>{t('onboarding.work.permission.scope')}</Tip>
            {settings
              ? agents.map((agent) => (
                  <AgentDefaultsCard key={agent} config={settings.agentDefaults[agent]} onChange={(config) => updateDefault.mutate(config)} />
                ))
              : null}
          </>
        ) : null}
      </div>

      {/* Une ligne, pas une carte : les points de reprise se règlent par projet, la visite
          ne fait que dire qu'ils existent, et qu'ils sont là d'office. */}
      <p className="flex gap-2 text-xs leading-relaxed text-ink-faint">
        <History size={14} className="mt-0.5 shrink-0 text-positive" aria-hidden />
        <span>
          <span className="font-medium text-ink-soft">{t('project.settings.checkpoints')}</span> {t('onboarding.work.checkpoints.line')}
        </span>
      </p>
    </>
  )
}

/**
 * Les défauts d'un CLI, en détail : les catégories du composeur, celles qui comptent
 * ici, rendues en listes déroulantes serrées. Un composant par CLI parce que chaque
 * fournisseur sonde le CLI qu'il décrit, et qu'un hook ne se répète pas dans une boucle.
 */
function AgentDefaultsCard({ config, onChange }: { config: AgentConfig; onChange: (config: AgentConfig) => void }) {
  const t = useTranslate()
  const { groups, catalogError } = useAgentSettings({ config, onConfigChange: onChange })
  const shown = groups.filter(isDetailGroup)
  const model = shown.find((group) => group.key === 'model')
  const loading = !catalogError && model !== undefined && model.options.length === 0

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <AgentIcon agent={config.agent} size={16} />
        <span className="text-sm font-semibold text-ink">{AGENT_LABELS[config.agent]}</span>
        {loading ? <span className="ml-auto text-xs text-ink-faint">{t('onboarding.work.detail.loading')}</span> : null}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((group) => {
            const selected = group.options.find((option) => option.value === group.value)
            return (
              <div key={group.key} className="flex flex-col gap-1">
                <Select label={group.label} value={group.value} options={group.options} onChange={group.onChange} />
                {selected?.tone === 'caution' ? (
                  <p className="flex items-start gap-1.5 text-xs text-caution">
                    <ShieldAlert size={13} className="mt-0.5 shrink-0" />
                    <span>{selected.hint}</span>
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>
        {config.agent !== 'claude' ? <p className="text-xs text-ink-faint">{t('onboarding.work.detail.noBudget')}</p> : null}
      </div>
    </Card>
  )
}
