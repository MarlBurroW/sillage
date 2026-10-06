import { CalendarClock, ChevronRight } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import type { ConversationDto, ScheduledTaskDto } from '@sillage/protocol'
import { relativeDate } from '../lib/dates'
import { useTranslate } from '../lib/i18n'
import { SCHEDULE_STATE_LABELS, scheduleState, type ScheduleState } from '../lib/schedules'
import { cx } from './ui'

/** Tirs montrés sous une tâche ; le reste de l'historique est sur la page Planification. */
const RUNS_SHOWN = 5

const STATE_DOTS: Record<ScheduleState, string> = {
  running: 'bg-accent animate-pulse',
  paused: 'bg-line-strong',
  failed: 'bg-critical',
  done: 'bg-line-strong',
  waiting: 'bg-positive',
}

/**
 * Les tâches planifiées d'un projet dans la sidebar : une ligne par tâche, ses tirs
 * repliés dessous.
 *
 * C'est ici que vont les fils qui portent un `scheduleId`, sortis de la liste
 * principale : une tâche horaire y poserait vingt-quatre lignes par jour, et la liste
 * des sessions cesserait de dire ce sur quoi on travaille.
 *
 * `renderRun` plutôt qu'une ligne à soi : un tir est une conversation comme une autre
 * une fois ouvert, et sa ligne doit porter les mêmes signaux et le même menu.
 */
export function SidebarSchedules({
  projectId,
  tasks,
  conversations,
  onNavigate,
  renderRun,
}: {
  projectId: string
  tasks: ScheduledTaskDto[]
  /** Les fils du projet issus d'un tir, toutes tâches confondues. */
  conversations: ConversationDto[]
  onNavigate: () => void
  renderRun: (conversation: ConversationDto) => ReactNode
}) {
  const t = useTranslate()
  if (tasks.length === 0) return null

  return (
    <li className="mt-2" data-sidebar-schedules>
      <NavLink
        to={`/p/${projectId}/schedules`}
        onClick={onNavigate}
        className="flex h-7 items-center gap-1.5 rounded px-1 text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase transition-colors hover:text-ink-soft"
      >
        <CalendarClock size={11} className="shrink-0" />
        <span className="flex-1">{t('schedule.sidebar.heading')}</span>
        <span className="tabular-nums">{tasks.length}</span>
      </NavLink>
      <ul className="flex flex-col gap-px">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            conversations={conversations}
            onNavigate={onNavigate}
            renderRun={renderRun}
          />
        ))}
      </ul>
    </li>
  )
}

function TaskRow({
  task,
  conversations,
  onNavigate,
  renderRun,
}: {
  task: ScheduledTaskDto
  conversations: ConversationDto[]
  onNavigate: () => void
  renderRun: (conversation: ConversationDto) => ReactNode
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const state = scheduleState(task)
  // Les rangés restent atteignables par l'historique de la page : sous la tâche, on ne
  // garde que ce qui est encore frais.
  const runs = useMemo(
    () =>
      conversations
        .filter((entry) => entry.scheduleId === task.id && !entry.archivedAt)
        .sort((a, b) => b.createdAt - a.createdAt),
    [conversations, task.id],
  )

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title={`${task.name} · ${t(SCHEDULE_STATE_LABELS[state])}`}
        className="flex min-h-11 w-full items-center gap-1.5 rounded-md px-1 text-left text-sm text-ink-soft transition-colors hover:bg-surface-high hover:text-ink md:min-h-8 pointer-coarse:min-h-11"
      >
        <ChevronRight size={11} className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
        <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', STATE_DOTS[state])} />
        <span className="sr-only">{t(SCHEDULE_STATE_LABELS[state])}</span>
        <span className="min-w-0 flex-1 truncate">{task.name}</span>
        <span className="shrink-0 text-[0.6875rem] text-ink-faint">
          {task.lastRunAt ? relativeDate(task.lastRunAt) : t('schedule.fact.never')}
        </span>
      </button>
      {open ? (
        <ul className="mb-1 ml-2.5 flex flex-col gap-px border-l border-line pl-1">
          {runs.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-ink-faint">{t('schedule.history.empty')}</li>
          ) : (
            runs.slice(0, RUNS_SHOWN).map(renderRun)
          )}
          {runs.length > RUNS_SHOWN || task.runs.length > runs.length ? (
            <li>
              <NavLink
                to={`/p/${task.projectId}/schedules`}
                onClick={onNavigate}
                className="flex min-h-9 items-center rounded px-2 text-xs text-ink-faint hover:bg-surface-high hover:text-ink-soft"
              >
                {t('schedule.sidebar.allRuns')}
              </NavLink>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
}
