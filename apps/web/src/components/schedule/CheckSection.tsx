import { FlaskConical, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import {
  CHECK_SKIP_EXIT_CODE,
  MAX_CHECK_TIMEOUT_SECONDS,
  MIN_CHECK_TIMEOUT_SECONDS,
  type ScheduleCheckResultDto,
  type ScheduleCheckVerdict,
} from '@sillage/protocol'
import type { ScheduledTaskDto } from '@sillage/protocol'
import { ScriptEditor } from '../automation/ScriptEditor'
import { Badge, Banner, Button, ConfirmDialog, Field } from '../ui'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { useApproveScheduleCheck, useTestScheduleCheck } from '../../lib/schedules'

/**
 * Pre-turn check in task forms: script, timeout, and server trial without launching work. Test
 * current form text rather than saved text because users need verification before saving.
 */
export function CheckSection({
  projectId,
  taskId,
  script,
  timeout,
  onScriptChange,
  onTimeoutChange,
}: {
  projectId: string
  /** Edited task for trial-state copies; absent during creation. */
  taskId?: string
  /** Null means no check. */
  script: string | null
  timeout: string
  onScriptChange: (script: string | null) => void
  onTimeoutChange: (timeout: string) => void
}) {
  const t = useTranslate()
  const test = useTestScheduleCheck(projectId)
  const seconds = Number(timeout)
  const timeoutValid =
    Number.isInteger(seconds) && seconds >= MIN_CHECK_TIMEOUT_SECONDS && seconds <= MAX_CHECK_TIMEOUT_SECONDS

  return (
    <fieldset className="flex flex-col gap-2" data-check-section>
      <legend className="mb-1.5 flex w-full items-center justify-between gap-2 text-sm font-medium text-ink-soft">
        <span>{t('schedule.check.title')}</span>
        {script === null ? (
          <Button type="button" size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => onScriptChange(t('schedule.check.starter'))}>
            {t('schedule.check.add')}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => { onScriptChange(null); test.reset() }}>
            {t('schedule.check.remove')}
          </Button>
        )}
      </legend>
      <p className="text-xs text-ink-faint">{t('schedule.check.description', { skip: CHECK_SKIP_EXIT_CODE })}</p>

      {script === null ? null : (
        <>
          <ScriptEditor value={script} onChange={onScriptChange} label={t('schedule.check.title')} language="check.sh" maxHeight="18rem" />
          <p className="text-xs text-ink-faint">{t('schedule.check.contract', { skip: CHECK_SKIP_EXIT_CODE })}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field
                label={t('schedule.check.timeout')}
                type="number"
                min={MIN_CHECK_TIMEOUT_SECONDS}
                max={MAX_CHECK_TIMEOUT_SECONDS}
                value={timeout}
                error={timeoutValid ? undefined : t('schedule.check.timeoutInvalid', { min: MIN_CHECK_TIMEOUT_SECONDS, max: MAX_CHECK_TIMEOUT_SECONDS })}
                onChange={(event) => onTimeoutChange(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<FlaskConical size={14} />}
              disabled={!script.trim() || !timeoutValid || test.isPending}
              onClick={() => test.mutate({ script, timeoutSeconds: seconds, taskId })}
            >
              {t(test.isPending ? 'schedule.check.testing' : 'schedule.check.test')}
            </Button>
          </div>
          <p className="text-xs text-ink-faint">{t('schedule.check.testHint')}</p>
          {test.isError ? <Banner>{test.error.message}</Banner> : null}
          {test.data ? <CheckResult result={test.data} /> : null}
        </>
      )}
    </fieldset>
  )
}

const VERDICT_LABELS: Record<ScheduleCheckVerdict, MessageKey> = {
  launch: 'schedule.check.verdict.launch',
  skip: 'schedule.check.verdict.skip',
  error: 'schedule.check.verdict.error',
}

const VERDICT_TONES: Record<ScheduleCheckVerdict, 'positive' | 'neutral' | 'critical'> = {
  launch: 'positive',
  skip: 'neutral',
  error: 'critical',
}

/** Trial verdict and both outputs unchanged. */
export function CheckResult({ result }: { result: ScheduleCheckResultDto }) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3" data-check-result={result.verdict}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        <Badge tone={VERDICT_TONES[result.verdict]}>{t(VERDICT_LABELS[result.verdict])}</Badge>
        <span>
          {result.timedOut
            ? t('schedule.check.timedOut')
            : t('schedule.check.exitCode', { code: result.exitCode ?? '—' })}
        </span>
        <span>· {t('schedule.check.duration', { seconds: (result.durationMs / 1000).toFixed(1) })}</span>
      </div>
      <Output label={t('schedule.check.stdout')} text={result.stdout} empty={t('schedule.check.emptyOutput')} />
      {result.stderr.trim() ? <Output label={t('schedule.check.stderr')} text={result.stderr} /> : null}
    </div>
  )
}

function Output({ label, text, empty }: { label: string; text: string; empty?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-soft">{label}</span>
      <pre className="max-h-48 overflow-auto rounded bg-sunken px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-ink-soft">
        {text.trim() ? text : <span className="text-ink-faint">{empty}</span>}
      </pre>
    </div>
  )
}

/** Agent-proposed script to review and test before approval. */
export function CheckReview({
  projectId,
  taskId,
  script,
  timeoutSeconds,
}: {
  projectId: string
  taskId: string
  script: string
  timeoutSeconds: number
}) {
  const t = useTranslate()
  const test = useTestScheduleCheck(projectId)
  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-64 overflow-auto rounded bg-sunken px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-ink">{script}</pre>
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<FlaskConical size={14} />}
          disabled={test.isPending}
          onClick={() => test.mutate({ script, timeoutSeconds, taskId })}
        >
          {t(test.isPending ? 'schedule.check.testing' : 'schedule.check.test')}
        </Button>
      </div>
      {test.isError ? <Banner>{test.error.message}</Banner> : null}
      {test.data ? <CheckResult result={test.data} /> : null}
      <p className="flex items-start gap-1.5 text-xs text-ink-faint">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        {t('schedule.check.reviewHint')}
      </p>
    </div>
  )
}

/**
 * Agent script approval: text, trial, and a button approving exactly that text. Opened from task
 * cards or schedule_task calls in conversations.
 */
export function CheckApprovalDialog({
  task,
  open,
  onOpenChange,
}: {
  task: ScheduledTaskDto
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslate()
  const approve = useApproveScheduleCheck()
  const check = task.check
  if (!check) return null
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('schedule.check.reviewTitle', { name: task.name })}
      confirmLabel={t('schedule.check.approve')}
      busy={approve.isPending}
      onConfirm={() => approve.mutate({ id: task.id, script: check.script }, { onSuccess: () => onOpenChange(false) })}
    >
      <CheckReview projectId={task.projectId} taskId={task.id} script={check.script} timeoutSeconds={check.timeoutSeconds} />
      {approve.isError ? <Banner>{approve.error.message}</Banner> : null}
    </ConfirmDialog>
  )
}
