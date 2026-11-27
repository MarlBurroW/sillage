import { CircleCheck, CircleSlash, CircleX, ScrollText, SquareTerminal, X } from 'lucide-react'
import { useEffect } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { unwatchRun, useActions, useRunAction, useWatchedRuns } from '../../lib/actions'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { showTerminal } from '../../lib/panel'
import { projectViewOf, projectViewPath } from '../../lib/project-view'
import { dismissToast, pushToast, type ActionRunNotice } from '../../lib/toasts'
import { Button, IconButton, cx } from '../ui'
import { formatDuration } from '../chat/ToolCall'

/** A service still up after this long started as intended: stop following it. */
const SERVICE_WATCH_MS = 60_000
/** A success needs nothing from the reader. */
const SUCCESS_TTL_MS = 6_000
/** Durations come from polling, a couple of seconds off: below this they would mislead. */
const SHOWN_DURATION_MS = 5_000

/**
 * Reports how the runs this tab launched ended (`useRunAction` follows them). Launching no longer
 * opens the panel, so the end of a task behind a closed panel has to be told: success briefly,
 * failure until dismissed, each with its output one click away.
 */
export function ActionRunNotices() {
  const runs = useWatchedRuns()
  const { data: actions, dataUpdatedAt } = useActions()

  useEffect(() => {
    if (!actions || runs.length === 0) return
    const now = Date.now()
    for (const run of runs) {
      // A list fetched before the launch does not know its terminal yet.
      if (dataUpdatedAt < run.startedAt) continue
      const action = actions.find((candidate) => candidate.id === run.actionId)
      if (!action) {
        unwatchRun(run.actionId)
        continue
      }
      const base = { kind: 'actionRun', actionId: action.id, projectId: action.projectId, label: action.label, durationMs: now - run.startedAt } as const

      if (run.terminalId) {
        const last = action.lastRun
        // Closed or replaced elsewhere: nothing left to report on.
        if (!last || last.terminalId !== run.terminalId) {
          unwatchRun(run.actionId)
          continue
        }
        if (last.alive) {
          // A service without systemd runs in a terminal; staying up is what it should do.
          if (action.kind === 'service' && now - run.startedAt > SERVICE_WATCH_MS) unwatchRun(run.actionId)
          continue
        }
        unwatchRun(run.actionId)
        const outcome: ActionRunNotice['outcome'] =
          last.exitCode === null ? 'interrupted' : action.kind === 'service' ? (last.exitCode === 0 ? 'serviceStopped' : 'serviceFailed') : last.exitCode === 0 ? 'succeeded' : 'failed'
        pushToast(
          { ...base, outcome, exitCode: last.exitCode, terminalId: last.terminalId },
          outcome === 'succeeded' ? { ttlMs: SUCCESS_TTL_MS } : undefined,
        )
        continue
      }

      const state = action.service?.state
      if (state === 'failed' || state === 'inactive') {
        unwatchRun(run.actionId)
        pushToast({ ...base, outcome: state === 'failed' ? 'serviceFailed' : 'serviceStopped', exitCode: null, terminalId: null })
      } else if (!state || now - run.startedAt > SERVICE_WATCH_MS) {
        unwatchRun(run.actionId)
      }
    }
  }, [actions, dataUpdatedAt, runs])

  return null
}

const TITLES: Record<ActionRunNotice['outcome'], MessageKey> = {
  succeeded: 'actions.notice.succeeded',
  failed: 'actions.notice.failed',
  interrupted: 'actions.notice.interrupted',
  serviceFailed: 'actions.notice.serviceFailed',
  serviceStopped: 'actions.notice.serviceStopped',
}

/** Toast for an action run's end, in the shape of the other toasts. */
export function ActionRunToast({ id, notice }: { id: string; notice: ActionRunNotice }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const projectRoute = useMatch('/p/:projectId/*')
  const { data: actions } = useActions()
  const { mutate: run } = useRunAction()
  const ok = notice.outcome === 'succeeded'
  const stopped = notice.outcome === 'interrupted' || notice.outcome === 'serviceStopped'
  const tone = ok ? 'text-positive' : stopped ? 'text-ink-faint' : 'text-critical'

  const open = () => {
    dismissToast(id)
    // The panel shows the current project's terminals.
    if (projectRoute?.params.projectId !== notice.projectId) {
      navigate(projectViewPath(notice.projectId, projectViewOf(notice.projectId)))
    }
    if (notice.terminalId) {
      showTerminal(notice.terminalId)
      return
    }
    const action = actions?.find((candidate) => candidate.id === notice.actionId)
    if (action) run({ action, op: 'logs' })
  }

  return (
    <div
      role="status"
      className={cx(
        'surface pointer-events-auto flex gap-3 rounded-xl border p-3.5 shadow-pop',
        ok ? 'border-positive/40' : stopped ? 'border-line' : 'border-critical/40',
      )}
    >
      <span className={cx('mt-0.5 shrink-0', tone)}>
        {ok ? <CircleCheck size={18} /> : stopped ? <CircleSlash size={18} /> : <CircleX size={18} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx('text-xs font-medium', tone)}>
          {t(TITLES[notice.outcome], { code: notice.exitCode ?? '' })}
        </p>
        <p className="mt-0.5 truncate text-sm font-medium text-ink">{notice.label}</p>
        {notice.durationMs >= SHOWN_DURATION_MS ? (
          <p className="mt-0.5 truncate text-xs text-ink-faint">
            {t('actions.notice.after', { duration: formatDuration(Math.round(notice.durationMs / 1000) * 1000) })}
          </p>
        ) : null}
        <div className="mt-2.5 flex gap-2">
          <Button
            size="sm"
            variant={ok ? 'ghost' : 'primary'}
            icon={notice.terminalId ? <SquareTerminal size={14} /> : <ScrollText size={14} />}
            onClick={open}
          >
            {t(notice.terminalId ? 'actions.notice.output' : 'actions.notice.logs')}
          </Button>
        </div>
      </div>
      <IconButton size="sm" label={t('common.close')} onClick={() => dismissToast(id)}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
