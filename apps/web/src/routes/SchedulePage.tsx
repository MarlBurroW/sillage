import { ArrowUpRight, CalendarClock, ChevronRight, Pause, Pencil, Play, Plus, Trash2, Zap } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ScheduleRunStatus, ScheduledRunDto, ScheduledTaskDto } from '@sillage/protocol'
import { AgentIcon } from '../components/AgentIcon'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { ScheduleDialog } from '../components/schedule/ScheduleDialog'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, IconButton, cx } from '../components/ui'
import { cronToHuman } from '../lib/cron'
import { relativeDate } from '../lib/dates'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { useProjects } from '../lib/projects'
import {
  SCHEDULE_STATE_LABELS,
  describeCadence,
  formatDateTime,
  scheduleState,
  useDeleteSchedule,
  useRunSchedule,
  useSchedules,
  useUpdateSchedule,
  type ScheduleState,
} from '../lib/schedules'
import { useSidebarHidden } from '../lib/sidebar'

const STATE_TONES: Record<ScheduleState, 'neutral' | 'accent' | 'critical' | 'positive'> = {
  running: 'accent',
  paused: 'neutral',
  failed: 'critical',
  done: 'neutral',
  waiting: 'positive',
}

const RUN_LABELS: Record<ScheduleRunStatus, MessageKey> = {
  running: 'schedule.run.running',
  succeeded: 'schedule.run.succeeded',
  failed: 'schedule.run.failed',
  timed_out: 'schedule.run.timedOut',
  skipped: 'schedule.run.skipped',
}

const RUN_DOTS: Record<ScheduleRunStatus, string> = {
  running: 'bg-accent animate-pulse',
  succeeded: 'bg-positive',
  failed: 'bg-critical',
  timed_out: 'bg-caution',
  skipped: 'bg-line-strong',
}

/**
 * Les tâches planifiées d'un projet : ce que le daemon rejoue tout seul, et ce que
 * chaque tir a donné.
 *
 * Une page par projet et non un réglage d'instance : une tâche travaille dans un dépôt,
 * avec les consignes et la mémoire de ce projet, et c'est là qu'on vient la chercher.
 */
export function SchedulePage() {
  const { projectId } = useParams()
  const t = useTranslate()
  const sidebarHidden = useSidebarHidden()
  const { data: projects } = useProjects()
  const { data: schedules, isPending, isError } = useSchedules()
  const project = projects?.find((entry) => entry.id === projectId)
  const tasks = useMemo(
    () => (schedules ?? []).filter((task) => task.projectId === projectId),
    [schedules, projectId],
  )

  // `null` : fermé ; `'new'` : création ; sinon la tâche en cours de modification.
  const [editing, setEditing] = useState<ScheduledTaskDto | 'new' | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className={cx(
          'flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3 md:px-6',
          sidebarHidden && 'md:pl-14',
        )}
      >
        <MobileNavigationButton />
        <CalendarClock size={19} className="shrink-0 text-ink-faint" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{t('schedule.title')}</h1>
          {project ? <p className="truncate text-xs text-ink-faint">{project.name}</p> : null}
        </div>
        {tasks.length > 0 ? <Badge>{tasks.length}</Badge> : null}
        <div className="ml-auto">
          <Button size="sm" icon={<Plus size={15} />} disabled={!project} onClick={() => setEditing('new')}>
            {t('schedule.new')}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <p className="text-sm text-ink-soft">{t('schedule.description')}</p>
          {isError ? <Banner>{t('schedule.loadError')}</Banner> : null}
          {isPending ? (
            <p role="status" className="text-sm text-ink-faint">{t('schedule.loading')}</p>
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={<CalendarClock size={22} />}
              title={t('schedule.empty')}
              description={t('schedule.emptyHint')}
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {tasks.map((task) => (
                <TaskCard key={task.id} task={task} onEdit={() => setEditing(task)} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {editing && project ? (
        <ScheduleDialog
          // La clé remonte le formulaire d'une tâche à l'autre : ses champs sont un état
          // initial, pas un reflet de la tâche.
          key={editing === 'new' ? 'new' : editing.id}
          project={project}
          task={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  )
}

function TaskCard({ task, onEdit }: { task: ScheduledTaskDto; onEdit: () => void }) {
  const t = useTranslate()
  const update = useUpdateSchedule()
  const run = useRunSchedule()
  const remove = useDeleteSchedule()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const state = scheduleState(task)
  const error = update.error ?? run.error ?? remove.error

  return (
    <li className="surface flex min-w-0 flex-col gap-3 rounded-lg border border-line p-4" data-schedule={task.name}>
      <div className="flex flex-wrap items-center gap-2">
        <AgentIcon agent={task.agent} size={16} />
        <h2 className="min-w-0 flex-1 font-medium break-words">{task.name}</h2>
        <Badge tone={STATE_TONES[state]}>{t(SCHEDULE_STATE_LABELS[state])}</Badge>
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-xs text-ink-soft sm:grid-cols-2">
        <Fact label={t('schedule.fact.cadence')}>
          {describeCadence(task.cadence, (expression) => cronToHuman(expression, locale()))}
        </Fact>
        <Fact label={t('schedule.fact.next')}>
          {task.nextRunAt ? formatDateTime(task.nextRunAt) : t('schedule.fact.none')}
        </Fact>
        <Fact label={t('schedule.fact.last')}>
          {task.lastRunAt ? relativeDate(task.lastRunAt) : t('schedule.fact.never')}
        </Fact>
        <Fact label={t('schedule.fact.limit')}>
          {t('schedule.fact.limitValue', {
            minutes: task.maxDurationMinutes,
            overlap: t(task.overlapPolicy === 'skip' ? 'schedule.form.overlap.skip' : 'schedule.form.overlap.wait'),
          })}
        </Fact>
      </dl>

      <p className="line-clamp-3 rounded-md bg-sunken px-3 py-2 text-xs whitespace-pre-wrap text-ink-soft">
        {task.prompt}
      </p>

      {error ? <Banner>{error.message}</Banner> : null}

      <div className="flex flex-wrap items-center gap-1 border-t border-line pt-3">
        <Button
          variant="secondary"
          size="sm"
          icon={<Zap size={14} />}
          disabled={run.isPending || state === 'running'}
          onClick={() => run.mutate(task.id)}
        >
          {t('schedule.action.runNow')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={task.enabled ? <Pause size={14} /> : <Play size={14} />}
          // Une ponctuelle déjà tirée n'a plus de date à venir : la reprendre demande
          // d'en choisir une, donc de passer par le formulaire.
          disabled={update.isPending || state === 'done'}
          onClick={() => update.mutate({ id: task.id, enabled: !task.enabled })}
        >
          {t(task.enabled ? 'schedule.action.pause' : 'schedule.action.resume')}
        </Button>
        <Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
          {t('schedule.action.edit')}
        </Button>
        <span className="ml-auto">
          <IconButton label={t('schedule.action.delete')} onClick={() => setConfirming(true)}>
            <Trash2 size={16} />
          </IconButton>
        </span>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((current) => !current)}
          className="flex min-h-9 items-center gap-1 rounded px-1 text-xs text-ink-faint transition-colors hover:text-ink-soft"
        >
          <ChevronRight size={12} className={cx('transition-transform', historyOpen && 'rotate-90')} />
          {t('schedule.history', { count: task.runs.length })}
        </button>
        {historyOpen ? (
          task.runs.length === 0 ? (
            <p className="px-1 py-1 text-xs text-ink-faint">{t('schedule.history.empty')}</p>
          ) : (
            <ul className="flex flex-col">
              {task.runs.map((entry) => (
                <RunRow key={entry.id} run={entry} projectId={task.projectId} />
              ))}
            </ul>
          )
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('schedule.delete.title', { name: task.name })}
        confirmLabel={t('schedule.action.delete')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(task.id, { onSettled: () => setConfirming(false) })}
      >
        <p>{t('schedule.delete.body')}</p>
      </ConfirmDialog>
    </li>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function RunRow({ run, projectId }: { run: ScheduledRunDto; projectId: string }) {
  const t = useTranslate()
  const body = (
    <>
      <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', RUN_DOTS[run.status])} />
      <span className="shrink-0 tabular-nums" title={new Date(run.startedAt).toLocaleString(locale())}>
        {formatDateTime(run.startedAt)}
      </span>
      <span className="shrink-0 text-ink-soft">{t(RUN_LABELS[run.status])}</span>
      {run.trigger === 'manual' ? <span className="shrink-0">{t('schedule.run.manual')}</span> : null}
      {run.error ? <span className="min-w-0 truncate" title={run.error}>{run.error}</span> : null}
    </>
  )
  const className = 'flex min-h-9 min-w-0 items-center gap-2 rounded px-1 text-xs text-ink-faint'

  return (
    <li>
      {run.conversationId ? (
        <Link
          to={`/p/${projectId}/c/${run.conversationId}`}
          className={cx(className, 'transition-colors hover:bg-surface-high hover:text-ink')}
        >
          {body}
          <ArrowUpRight size={13} className="ml-auto shrink-0" />
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  )
}
