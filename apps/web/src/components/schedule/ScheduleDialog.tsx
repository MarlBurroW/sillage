import * as Dialog from '@radix-ui/react-dialog'
import { ShieldAlert, X } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import {
  DEFAULT_SCHEDULE_DURATION_MINUTES,
  MAX_SCHEDULE_DURATION_MINUTES,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULE_PROMPT_CHARS,
  MIN_SCHEDULE_DURATION_MINUTES,
  agentKindSchema,
  defaultConfigFor,
  nextScheduleRun,
  scheduleCadenceSchema,
  type AgentConfig,
  type AgentKind,
  type ProjectDto,
  type ScheduleCadence,
  type ScheduleOverlapPolicy,
  type ScheduledTaskDto,
} from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useAgentSettings } from '../chat/agent-settings'
import type { SettingGroup } from '../chat/ComposerSettings'
import { Banner, Button, Field, IconButton, Select, cx } from '../ui'
import { cronToHuman } from '../../lib/cron'
import { locale, useTranslate, type MessageKey } from '../../lib/i18n'
import { formatDateTime, useCreateSchedule, useUpdateSchedule, type ScheduleInput } from '../../lib/schedules'
import { useUserSettings } from '../../lib/user-settings'

/**
 * Création et modification d'une tâche planifiée.
 *
 * Les réglages du CLI sont ceux du composer, à la même source (`useAgentSettings`) :
 * une tâche est une conversation qu'on écrit d'avance, et lui inventer un second jeu de
 * modèles et de modes de permission aurait garanti que les deux divergent.
 */

type CadenceKind = ScheduleCadence['kind']
type IntervalUnit = 'minutes' | 'hours' | 'days'

const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 }

const CRON_PRESETS: { labelKey: MessageKey; expression: string }[] = [
  { labelKey: 'schedule.form.preset.hourly', expression: '0 * * * *' },
  { labelKey: 'schedule.form.preset.daily', expression: '0 9 * * *' },
  { labelKey: 'schedule.form.preset.weekdays', expression: '0 9 * * 1-5' },
  { labelKey: 'schedule.form.preset.weekly', expression: '0 9 * * 1' },
]

/** Valeur d'un champ `datetime-local`, à l'heure du poste. */
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
}: {
  project: ProjectDto
  /** La tâche à modifier ; absente pour une création. */
  task?: ScheduledTaskDto
  onClose: () => void
}) {
  const t = useTranslate()
  const promptId = useId()
  const create = useCreateSchedule(project.id)
  const update = useUpdateSchedule()
  const mutation = task ? update : create
  const { data: userSettings } = useUserSettings()

  const [name, setName] = useState(task?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [kind, setKind] = useState<CadenceKind>(task?.cadence.kind ?? 'interval')
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

  // Même ordre que pour une conversation neuve : le préréglage du projet, puis les
  // défauts du compte. Une configuration d'un autre CLI est abandonnée, pas convertie.
  const defaults =
    project.defaultConfig[agent] ?? userSettings?.agentDefaults[agent] ?? defaultConfigFor(agent)
  const config = edited?.agent === agent ? edited : defaults
  const { groups, catalogError } = useAgentSettings({ config, onConfigChange: setEdited })

  const cadence = useMemo((): ScheduleCadence | null => {
    const candidate =
      kind === 'interval'
        ? { kind, minutes: Number(intervalValue) * UNIT_MINUTES[intervalUnit] }
        : kind === 'cron'
          ? { kind, expression: cron.trim() }
          : { kind, at: new Date(onceAt).getTime() }
    const parsed = scheduleCadenceSchema.safeParse(candidate)
    return parsed.success ? parsed.data : null
  }, [kind, intervalValue, intervalUnit, cron, onceAt])

  // Le même calcul que le daemon : ce que l'aperçu annonce est ce qui sera armé, au
  // fuseau près, les heures d'un motif se lisant sur l'horloge du serveur.
  const nextRun = useMemo(() => (cadence ? nextScheduleRun(cadence, Date.now(), task?.lastRunAt ?? null) : null), [cadence, task?.lastRunAt])
  const cronHuman = useMemo(() => (kind === 'cron' ? cronToHuman(cron, locale()) : null), [kind, cron])

  const duration = Number(maxDuration)
  const durationValid =
    Number.isInteger(duration) && duration >= MIN_SCHEDULE_DURATION_MINUTES && duration <= MAX_SCHEDULE_DURATION_MINUTES
  const valid = Boolean(name.trim() && prompt.trim() && cadence && nextRun !== null && durationValid)

  const submit = () => {
    if (!valid || !cadence || mutation.isPending) return
    const input: ScheduleInput = {
      name: name.trim(),
      agent,
      config,
      prompt: prompt.trim(),
      cadence,
      overlapPolicy: overlap,
      maxDurationMinutes: duration,
    }
    if (task) update.mutate({ id: task.id, ...input }, { onSuccess: onClose })
    else create.mutate(input, { onSuccess: onClose })
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
              {t(task ? 'schedule.form.editTitle' : 'schedule.form.createTitle')}
            </Dialog.Title>
            <IconButton label={t('common.close')} disabled={mutation.isPending} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>

          <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); submit() }}>
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-5 sm:p-6">
              <Field
                label={t('schedule.form.name')}
                placeholder={t('schedule.form.namePlaceholder')}
                maxLength={MAX_SCHEDULE_NAME_CHARS}
                value={name}
                autoFocus={!task}
                onChange={(event) => setName(event.target.value)}
              />

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
                <p className="text-xs text-ink-faint">{t('schedule.form.promptHint')}</p>
              </div>

              <fieldset className="flex flex-col gap-2">
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
              </fieldset>

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
                    { value: 'skip', label: t('schedule.form.overlap.skip'), hint: t('schedule.form.overlap.skipHint') },
                    { value: 'wait', label: t('schedule.form.overlap.wait'), hint: t('schedule.form.overlap.waitHint') },
                  ]}
                />
              </div>

              {mutation.isError ? <Banner>{mutation.error.message}</Banner> : null}
            </div>

            <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!valid || mutation.isPending}>
                {t(task ? 'schedule.form.save' : 'schedule.form.create')}
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Une catégorie de réglage en liste déroulante, comme sur l'écran des défauts du compte. */
function GroupField({ group }: { group: SettingGroup }) {
  const selected = group.options.find((option) => option.value === group.value)
  return (
    <div className="flex flex-col gap-1.5">
      <Select label={group.label} value={group.value} options={group.options} onChange={group.onChange} />
      {selected?.tone === 'caution' ? (
        <p className="flex items-start gap-1.5 text-xs text-caution">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          <span>{selected.hint}</span>
        </p>
      ) : null}
    </div>
  )
}
