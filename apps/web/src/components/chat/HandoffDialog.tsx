import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  agentKindSchema,
  defaultConfigFor,
  type AgentConfig,
  type AgentKind,
  type ConversationDto,
} from '@sillage/protocol'
import { AGENT_LABELS, AGENT_META, AgentIcon } from '../AgentIcon'
import { catalogModel, unavailableReason, useAgentAvailability, useAgentModels } from '../../lib/agents'
import { handoffConversation } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { useProjects } from '../../lib/projects'
import { useUserSettings } from '../../lib/user-settings'
import { Banner, Button, ChoiceList, IconButton, Select, cx } from '../ui'
import { AccountChoice } from './AccountChoice'

/**
 * Continuer la conversation avec un autre CLI.
 *
 * Trois choix, les mêmes qu'au brouillon : le CLI, son modèle, le compte. Le CLI
 * courant n'est pas proposé, le fork existe pour ça. L'étendue du contexte transféré
 * se règle ici et nulle part ailleurs : c'est au moment de passer la main qu'on sait
 * si la suite a besoin de tout le fil ou seulement de sa fin.
 */

/** Budgets proposés, en jetons : le défaut au milieu, les bornes du serveur aux bouts. */
const BUDGETS = [8_000, 16_000, 32_000, 64_000] as const
const DEFAULT_BUDGET = 16_000

export function HandoffDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: ConversationDto
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: availability } = useAgentAvailability()
  const { data: projects } = useProjects()
  const { data: userSettings } = useUserSettings()

  const others = agentKindSchema.options.filter((agent) => agent !== source.agent)
  const [chosen, setChosen] = useState<AgentKind | null>(null)
  // Le premier CLI installé parmi les autres, tant que rien n'est choisi : ouvrir le
  // dialogue sur une option grisée obligerait à un clic de plus pour rien.
  const agent =
    chosen ??
    others.find((candidate) => unavailableReason(availability?.agents.find((a) => a.agent === candidate)) === null) ??
    others[0]!

  const { data: catalog, isPending: modelsPending } = useAgentModels(agent, open)
  const project = projects?.find((entry) => entry.id === source.projectId)
  const defaults = useMemo(
    () => project?.defaultConfig[agent] ?? userSettings?.agentDefaults[agent] ?? defaultConfigFor(agent),
    [project, userSettings, agent],
  )
  // Comme au brouillon : une configuration faite pour un CLI est abandonnée dès qu'on
  // en choisit un autre.
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const effective = config?.agent === agent ? config : defaults

  const [budget, setBudget] = useState<number>(DEFAULT_BUDGET)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const agentOptions = others.map((candidate) => {
    const entry = availability?.agents.find((a) => a.agent === candidate)
    return {
      value: candidate,
      label: AGENT_LABELS[candidate],
      hint: unavailableReason(entry) ?? AGENT_META[candidate].blurb,
      icon: <AgentIcon agent={candidate} size={15} />,
    }
  })
  const blocked = unavailableReason(availability?.agents.find((a) => a.agent === agent))

  const models = catalog?.models ?? []
  const modelOptions = models.map((model) => ({
    value: model.value,
    label: model.displayName,
    hint: [model.description, model.isDefault ? t('composer.model.default') : null].filter(Boolean).join(' · ') || undefined,
  }))
  const resolvedModel = effective.model || models.find((model) => model.isDefault)?.value || ''
  if (resolvedModel && !catalogModel(models, resolvedModel)) {
    modelOptions.push({ value: resolvedModel, label: resolvedModel, hint: t('composer.select.saved') })
  }

  const budgetOptions = BUDGETS.map((value) => ({
    value: String(value),
    label: t('conversation.handoff.budget.option', { count: Math.round(value / 1000) }),
    hint: value === DEFAULT_BUDGET ? t('conversation.handoff.budget.default') : undefined,
  }))

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const created = await handoffConversation(source.id, {
        agent,
        config: { ...effective, model: resolvedModel } as AgentConfig,
        budgetTokens: budget,
      })
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      onOpenChange(false)
      navigate(`/p/${created.projectId}/c/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('conversation.handoff.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cx(
            'surface fixed top-1/2 left-1/2 z-50 max-h-[85dvh] w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2',
            'flex flex-col gap-3 overflow-y-auto rounded-lg border border-line p-4 shadow-pop',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-[0.9375rem] font-semibold tracking-tight">
              {t('conversation.handoff.title')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label={t('common.close')}><X size={18} /></IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-sm text-ink-soft">
            {t('conversation.handoff.description', { agent: AGENT_LABELS[source.agent] })}
          </Dialog.Description>

          <ChoiceList
            label={t('conversation.handoff.agent')}
            value={agent}
            options={agentOptions}
            onChange={(value) => {
              setChosen(value)
              setConfig(null)
            }}
          />
          {blocked ? <Banner>{blocked}</Banner> : null}

          <Select
            label={t('composer.setting.model')}
            value={resolvedModel}
            options={modelOptions}
            placeholder={modelsPending ? t('conversation.handoff.modelsLoading') : undefined}
            disabled={modelOptions.length === 0 || blocked !== null}
            onChange={(model) => setConfig({ ...effective, model } as AgentConfig)}
          />

          <AccountChoice config={effective} onChange={setConfig} enabled={open && blocked === null} />

          <Select
            label={t('conversation.handoff.budget.label')}
            value={String(budget)}
            options={budgetOptions}
            onChange={(value) => setBudget(Number(value))}
          />
          <p className="text-xs text-ink-faint">{t('conversation.handoff.budget.hint')}</p>

          {error ? <Banner tone="critical">{error}</Banner> : null}

          <div className="mt-1 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost">{t('dialog.cancel')}</Button>
            </Dialog.Close>
            <Button variant="primary" disabled={busy || blocked !== null} onClick={() => void confirm()}>
              {busy ? t('conversation.handoff.running') : t('conversation.handoff.action', { agent: AGENT_LABELS[agent] })}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
