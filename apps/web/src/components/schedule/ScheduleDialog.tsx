import * as Dialog from '@radix-ui/react-dialog'
import { CalendarClock, Webhook, X } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import {
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  DEFAULT_DECISION_SETTINGS,
  DEFAULT_SCHEDULE_DURATION_MINUTES,
  MAX_CHECK_TIMEOUT_SECONDS,
  MIN_CHECK_TIMEOUT_SECONDS,
  MAX_SCHEDULE_DURATION_MINUTES,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULE_PROMPT_CHARS,
  MIN_SCHEDULE_DURATION_MINUTES,
  AUTOMATION_TEMPLATES,
  agentKindSchema,
  defaultConfigFor,
  nextScheduleRun,
  scheduleCadenceSchema,
  type AgentConfig,
  type AgentKind,
  type AutomationTemplateId,
  type DecisionSettings,
  type ProjectDto,
  type ScheduleCadence,
  type ScheduleOverlapPolicy,
  type ScheduledTaskDto,
} from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useAgentSettings } from '../chat/agent-settings'
import { CheckSection } from './CheckSection'
import { GroupField } from './GroupField'
import { DecisionSettingsField, decisionSettingsValid } from '../decisions/DecisionSettingsField'
import { Banner, Button, Field, IconButton, Select, cx } from '../ui'
import { cronToHuman } from '../../lib/cron'
import { locale, useTranslate, type MessageKey } from '../../lib/i18n'
import { TEMPLATE_LABELS } from '../../lib/automations'
import { formatDateTime, useCreateSchedule, useUpdateSchedule, type ScheduleInput } from '../../lib/schedules'
import { useUserSettings } from '../../lib/user-settings'

/**
 * Scheduled task creation and editing. CLI settings share the composer source (useAgentSettings):
 * tasks are conversations written in advance, and separate model/permission lists would diverge.
 */

type CadenceKind = Exclude<ScheduleCadence['kind'], 'webhook'>
type Trigger = 'schedule' | 'webhook'
type IntervalUnit = 'minutes' | 'hours' | 'days'

const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 }

const CRON_PRESETS: { labelKey: MessageKey; expression: string }[] = [
  { labelKey: 'schedule.form.preset.hourly', expression: '0 * * * *' },
  { labelKey: 'schedule.form.preset.daily', expression: '0 9 * * *' },
  { labelKey: 'schedule.form.preset.weekdays', expression: '0 9 * * 1-5' },
  { labelKey: 'schedule.form.preset.weekly', expression: '0 9 * * 1' },
]

/** datetime-local field value in device time. */
function toLocalInput(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function splitInterval(minutes: number): { value: string; unit: IntervalUnit } {
  if (minutes % 1440 === 0) return { value: String(minutes / 1440), unit: 'days' }
  if (minutes % 60 === 0) return { value: String(minutes / 60), unit: 'hours' }
  return { value: String(minutes), unit: 'minutes' }
}

export function ScheduleDialog({
  project,
  task,
  onClose,
  onCreated,
}: {
  project: ProjectDto
  /** Task being edited, absent during creation. */
  task?: ScheduledTaskDto
  onClose: () => void
  /** Created webhook automation: its host opens the configuration page. */
  onCreated?: (task: ScheduledTaskDto) => void
}) {
  const t = useTranslate()
  const promptId = useId()
  const create = useCreateSchedule(project.id)
  const update = useUpdateSchedule()
  const mutation = task ? update : create
  const { data: userSettings } = useUserSettings()

  const [name, setName] = useState(task?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  // Choose schedule versus webhook only at creation: one has a time, the other an address and log,
  // and the server forbids conversion.
  const [trigger, setTrigger] = useState<Trigger>(task?.cadence.kind === 'webhook' ? 'webhook' : 'schedule')
  const [template, setTemplate] = useState<AutomationTemplateId | 'generic'>('github_issue_label')
  const [kind, setKind] = useState<CadenceKind>(task && task.cadence.kind !== 'webhook' ? task.cadence.kind : 'interval')
  const initialInterval = splitInterval(task?.cadence.kind === 'interval' ? task.cadence.minutes : 1440)
  const [intervalValue, setIntervalValue] = useState(initialInterval.value)
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(initialInterval.unit)
  const [cron, setCron] = useState(task?.cadence.kind === 'cron' ? task.cadence.expression : '0 9 * * 1')
  const [onceAt, setOnceAt] = useState(() =>
    toLocalInput(task?.cadence.kind === 'once' ? task.cadence.at : Date.now() + 60 * 60_000),
  )
  const [agent, setAgent] = useState<AgentKind>(task?.agent ?? 'claude')
  const [edited, setEdited] = useState<AgentConfig | null>(task?.config ?? null)
  const [maxDuration, setMaxDuration] = useState(String(task?.maxDurationMinutes ?? DEFAULT_SCHEDULE_DURATION_MINUTES))
  const [overlap, setOverlap] = useState<ScheduleOverlapPolicy>(task?.overlapPolicy ?? 'skip')
  const [decisionSettings, setDecisionSettings] = useState<DecisionSettings>({
    decisionsEnabled: task?.decisionsEnabled ?? DEFAULT_DECISION_SETTINGS.decisionsEnabled,
    decisionMaxHours: task?.decisionMaxHours ?? DEFAULT_DECISION_SETTINGS.decisionMaxHours,
  })
  const [checkScript, setCheckScript] = useState<string | null>(task?.check?.script ?? null)
  const [checkTimeout, setCheckTimeout] = useState(String(task?.check?.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS))
  const templatePrompt = (id: AutomationTemplateId | 'generic') =>
    id === 'generic' ? '' : (AUTOMATION_TEMPLATES.find((entry) => entry.id === id)?.prompt[locale() === 'fr' ? 'fr' : 'en'] ?? '')

  const templateName = (id: AutomationTemplateId | 'generic') => (id === 'generic' ? '' : t(TEMPLATE_LABELS[id].name))

  // Create webhooks with template and name only. Triggers, session, prompt, and safeguards belong
  // on the page where real calls can test them. Forms create; pages configure.
  const webhookCreation = trigger === 'webhook' && !task

  const chooseTrigger = (next: Trigger) => {
    setTrigger(next)
    if (next === 'webhook' && !name.trim()) setName(templateName(template))
  }

  const chooseTemplate = (next: AutomationTemplateId | 'generic') => {
    // Follow the template name until manually edited.
    if (!name.trim() || name === templateName(template)) setName(templateName(next))
    setTemplate(next)
  }

  // Same precedence as new conversations: project preset then account defaults. Discard
  // configurations from other CLIs rather than converting.
  const defaults =
    project.defaultConfig[agent] ?? userSettings?.agentDefaults[agent] ?? defaultConfigFor(agent)
  const config = edited?.agent === agent ? edited : defaults
  const { groups, catalogError } = useAgentSettings({ config, onConfigChange: setEdited })

  const cadence = useMemo((): ScheduleCadence | null => {
    if (trigger === 'webhook') return { kind: 'webhook' }
    const candidate =
      kind === 'interval'
        ? { kind, minutes: Number(intervalValue) * UNIT_MINUTES[intervalUnit] }
        : kind === 'cron'
          ? { kind, expression: cron.trim() }
          : { kind, at: new Date(onceAt).getTime() }
    const parsed = scheduleCadenceSchema.safeParse(candidate)
    return parsed.success ? parsed.data : null
  }, [trigger, kind, intervalValue, intervalUnit, cron, onceAt])

  // Same calculation as the daemon: preview matches arming except timezone, since cron hours follow
  // server time.
  const nextRun = useMemo(() => (cadence ? nextScheduleRun(cadence, Date.now(), task?.lastRunAt ?? null) : null), [cadence, task?.lastRunAt])
  const cronHuman = useMemo(() => (kind === 'cron' ? cronToHuman(cron, locale()) : null), [kind, cron])

  const duration = Number(maxDuration)
  const durationValid =
    Number.isInteger(duration) && duration >= MIN_SCHEDULE_DURATION_MINUTES && duration <= MAX_SCHEDULE_DURATION_MINUTES
  const timeoutSeconds = Number(checkTimeout)
  // Empty script means no check; timeout must be readable.
  const checkValid =
    trigger !== 'schedule' ||
    checkScript === null ||
    !checkScript.trim() ||
    (Number.isInteger(timeoutSeconds) && timeoutSeconds >= MIN_CHECK_TIMEOUT_SECONDS && timeoutSeconds <= MAX_CHECK_TIMEOUT_SECONDS)
  const valid = webhookCreation
    ? Boolean(name.trim())
    : Boolean(name.trim() && prompt.trim() && cadence && durationValid && checkValid && decisionSettingsValid(decisionSettings) && (trigger === 'webhook' || nextRun !== null))

  const submit = () => {
    if (!valid || !cadence || mutation.isPending) return
    const input: ScheduleInput = webhookCreation
      ? {
          name: name.trim(),
          agent,
          config,
          // Template prompt edited later on the page alongside a real call.
          prompt: templatePrompt(template) || t('automation.form.genericPrompt'),
          cadence,
          // Webhooks receive bursts: queue calls rather than lose them during active sessions.
          overlapPolicy: 'wait',
          maxDurationMinutes: DEFAULT_SCHEDULE_DURATION_MINUTES,
          webhook: { template: template === 'generic' ? undefined : template },
        }
      : {
          name: name.trim(),
          agent,
          config,
          prompt: prompt.trim(),
          cadence,
          overlapPolicy: overlap,
          maxDurationMinutes: duration,
          ...decisionSettings,
          // Webhooks have their own page script; this one applies only to schedules.
          ...(trigger === 'schedule'
            ? {
                checkScript: checkScript?.trim() ? checkScript : null,
                ...(checkScript?.trim() ? { checkTimeoutSeconds: timeoutSeconds } : {}),
              }
            : {}),
        }
    if (task) update.mutate({ id: task.id, ...input }, { onSuccess: onClose })
    else {
      create.mutate(input, {
        onSuccess: (created) => {
          onClose()
          if (trigger === 'webhook') onCreated?.(created)
        },
      })
    }
  }

  const kinds: { value: CadenceKind; label: string }[] = [
    { value: 'interval', label: t('schedule.form.kind.interval') },
    { value: 'cron', label: t('schedule.form.kind.cron') },
    { value: 'once', label: t('schedule.form.kind.once') },
  ]

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !mutation.isPending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[95dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(640px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">
              {t(task ? 'schedule.form.editTitle' : 'automation.form.createTitle')}
            </Dialog.Title>
            <IconButton label={t('common.close')} disabled={mutation.isPending} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>

          <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); submit() }}>
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
              {task ? null : (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1.5 text-sm font-medium text-ink-soft">{t('automation.form.trigger')}</legend>
                  <div role="radiogroup" aria-label={t('automation.form.trigger')} className="grid gap-2 sm:grid-cols-2">
                    {([
                      { value: 'schedule', icon: <CalendarClock size={16} />, title: t('automation.form.trigger.schedule'), hint: t('automation.form.trigger.scheduleHint') },
                      { value: 'webhook', icon: <Webhook size={16} />, title: t('automation.form.trigger.webhook'), hint: t('automation.form.trigger.webhookHint') },
                    ] as const).map((entry) => (
                      <button
                        key={entry.value}
                        type="button"
                        role="radio"
                        aria-checked={trigger === entry.value}
                        onClick={() => chooseTrigger(entry.value)}
                        className={cx(
                          'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors',
                          trigger === entry.value ? 'border-accent bg-accent-wash' : 'border-line hover:border-line-strong',
                        )}
                      >
                        <span className={cx('mt-0.5 shrink-0', trigger === entry.value ? 'text-accent' : 'text-ink-faint')}>{entry.icon}</span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink">{entry.title}</span>
                          <span className="block text-xs text-ink-faint">{entry.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {trigger === 'webhook' && !task ? (
                <Select
                  label={t('automation.form.template')}
                  value={template}
                  onChange={chooseTemplate}
                  options={[
                    { value: 'generic', label: t('automation.template.generic'), hint: t('automation.template.genericHint') },
                    ...AUTOMATION_TEMPLATES.map((entry) => ({
                      value: entry.id,
                      label: t(TEMPLATE_LABELS[entry.id].title),
                      hint: t(TEMPLATE_LABELS[entry.id].description),
                    })),
                  ]}
                />
              ) : null}

              {webhookCreation ? (
                <p className="text-xs text-ink-faint">{t('automation.form.next')}</p>
              ) : null}

              <Field
                label={t('schedule.form.name')}
                placeholder={t(trigger === 'webhook' ? 'automation.form.namePlaceholder' : 'schedule.form.namePlaceholder')}
                maxLength={MAX_SCHEDULE_NAME_CHARS}
                value={name}
                autoFocus={!task}
                onChange={(event) => setName(event.target.value)}
              />

              {webhookCreation ? null : (
                <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={promptId} className="text-sm font-medium text-ink-soft">
                  {t('schedule.form.prompt')}
                </label>
                <textarea
                  id={promptId}
                  rows={7}
                  maxLength={MAX_SCHEDULE_PROMPT_CHARS}
                  value={prompt}
                  placeholder={t('schedule.form.promptPlaceholder')}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
                />
                <p className="text-xs text-ink-faint">{t(trigger === 'webhook' ? 'automation.form.promptHint' : 'schedule.form.promptHint')}</p>
              </div>

              {trigger === 'schedule' ? <fieldset className="flex flex-col gap-2">
                <legend className="mb-1.5 text-sm font-medium text-ink-soft">{t('schedule.form.cadence')}</legend>
                <div role="radiogroup" aria-label={t('schedule.form.cadence')} className="flex gap-1 rounded-md border border-line bg-sunken p-1">
                  {kinds.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      role="radio"
                      aria-checked={kind === entry.value}
                      onClick={() => setKind(entry.value)}
                      className={cx(
                        'min-h-9 flex-1 rounded px-2 text-sm transition-colors',
                        kind === entry.value ? 'bg-surface-high font-medium text-ink' : 'text-ink-faint hover:text-ink-soft',
                      )}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>

                {kind === 'interval' ? (
                  <div className="flex items-end gap-2">
                    <div className="w-28">
                      <Field
                        label={t('schedule.form.every')}
                        type="number"
                        min={1}
                        value={intervalValue}
                        onChange={(event) => setIntervalValue(event.target.value)}
                      />
                    </div>
                    <Select
                      className="flex-1"
                      value={intervalUnit}
                      onChange={setIntervalUnit}
                      placeholder={t('schedule.form.unit')}
                      options={[
                        { value: 'minutes', label: t('schedule.form.unit.minutes') },
                        { value: 'hours', label: t('schedule.form.unit.hours') },
                        { value: 'days', label: t('schedule.form.unit.days') },
                      ]}
                    />
                  </div>
                ) : null}

                {kind === 'cron' ? (
                  <>
                    <Field
                      label={t('schedule.form.cron')}
                      value={cron}
                      spellCheck={false}
                      error={cadence ? undefined : t('archiving.schedule.invalid')}
                      onChange={(event) => setCron(event.target.value)}
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {CRON_PRESETS.map((preset) => (
                        <button
                          key={preset.expression}
                          type="button"
                          onClick={() => setCron(preset.expression)}
                          className={cx(
                            'rounded-md border px-2 py-0.5 text-xs transition-colors',
                            preset.expression === cron
                              ? 'border-accent bg-accent-wash text-ink'
                              : 'border-line text-ink-faint hover:border-line-strong hover:text-ink-soft',
                          )}
                        >
                          {t(preset.labelKey)}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}

                {kind === 'once' ? (
                  <Field
                    label={t('schedule.form.onceAt')}
                    type="datetime-local"
                    value={onceAt}
                    error={cadence && nextRun === null ? t('schedule.form.oncePast') : undefined}
                    onChange={(event) => setOnceAt(event.target.value)}
                  />
                ) : null}

                {cadence && nextRun !== null ? (
                  <p className="text-xs text-ink-faint">
                    {cronHuman ? <span className="text-ink-soft">{cronHuman}. </span> : null}
                    {t('schedule.form.nextRun', { date: formatDateTime(nextRun) })}
                    {kind === 'cron' ? ` ${t('schedule.form.serverClock')}` : null}
                  </p>
                ) : null}
              </fieldset> : null}

              {trigger === 'schedule' ? (
                <CheckSection
                  projectId={project.id}
                  taskId={task?.id}
                  script={checkScript}
                  timeout={checkTimeout}
                  onScriptChange={setCheckScript}
                  onTimeoutChange={setCheckTimeout}
                />
              ) : null}

              <Select
                label={t('draft.cli.legend')}
                value={agent}
                onChange={setAgent}
                options={agentKindSchema.options.map((value) => ({
                  value,
                  label: AGENT_LABELS[value],
                  icon: <AgentIcon agent={value} size={16} />,
                }))}
              />

              {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
              {groups.map((group) => (
                <GroupField key={group.key} group={group} />
              ))}
              <Banner tone="info">{t('schedule.form.unattended')}</Banner>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={t('schedule.form.maxDuration')}
                  hint={t('schedule.form.maxDurationHint')}
                  error={durationValid ? undefined : t('schedule.form.maxDurationInvalid', { max: MAX_SCHEDULE_DURATION_MINUTES })}
                  type="number"
                  min={MIN_SCHEDULE_DURATION_MINUTES}
                  max={MAX_SCHEDULE_DURATION_MINUTES}
                  value={maxDuration}
                  onChange={(event) => setMaxDuration(event.target.value)}
                />
                <Select
                  label={t('schedule.form.overlap')}
                  value={overlap}
                  onChange={setOverlap}
                  options={[
                    { value: 'skip', label: t('schedule.form.overlap.skip'), hint: t(trigger === 'webhook' ? 'automation.form.overlap.skipHint' : 'schedule.form.overlap.skipHint') },
                    { value: 'wait', label: t('schedule.form.overlap.wait'), hint: t(trigger === 'webhook' ? 'automation.form.overlap.waitHint' : 'schedule.form.overlap.waitHint') },
                  ]}
                />
              </div>
              <DecisionSettingsField value={decisionSettings} onChange={setDecisionSettings} />

                </>
              )}

              {mutation.isError ? <Banner>{mutation.error.message}</Banner> : null}
            </div>

            <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!valid || mutation.isPending}>
                {t(task ? 'schedule.form.save' : trigger === 'webhook' ? 'automation.form.createAndConfigure' : 'schedule.form.create')}
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
