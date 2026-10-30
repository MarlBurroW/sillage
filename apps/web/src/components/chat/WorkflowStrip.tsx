import { CornerDownRight } from 'lucide-react'
import { useTranslate } from '../../lib/i18n'
import { showAgentList } from '../../lib/panel'
import { currentPhase, useWorkflowTask, workflowCounts } from '../../lib/workflows'
import { cx } from '../ui'

/**
 * Where a workflow launched by this call stands, under its card. The call returns as soon as the
 * workflow is launched, so without this line the thread only ever says "launched": the phase and
 * agent counts tell at a glance whether it is still working, and the button leads to its agents.
 */
export function WorkflowStrip({ toolCallId }: { toolCallId: string }) {
  const t = useTranslate()
  const task = useWorkflowTask(toolCallId)
  // Nothing to say without a snapshot: CLIs that omit it keep the bare card.
  if (!task || (!task.workflow && !task.done)) return null

  const parts: string[] = []
  if (task.done) {
    parts.push(t(`toolcall.workflow.ended.${task.outcome ?? 'completed'}`))
  } else if (task.workflow) {
    const phase = currentPhase(task.workflow)
    if (phase) parts.push(`${t('panel.workflow.phase', phase)} · ${phase.title}`)
  }
  if (task.workflow) {
    const counts = workflowCounts(task.workflow.agents)
    if (!task.done && counts.running > 0) {
      parts.push(t(counts.running > 1 ? 'toolcall.workflow.running.many' : 'toolcall.workflow.running.one', { count: counts.running }))
    }
    if (!task.done && counts.queued > 0) parts.push(t('toolcall.workflow.queued', { count: counts.queued }))
    if (counts.done > 0) parts.push(t(counts.done > 1 ? 'toolcall.workflow.done.many' : 'toolcall.workflow.done.one', { count: counts.done }))
    if (counts.failed > 0) parts.push(t('toolcall.workflow.failed', { count: counts.failed }))
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line px-2.5 py-1.5 text-[0.6875rem]">
      <span
        className={cx(
          // Wraps rather than truncates: on a phone the counts are what the line is for.
          'min-w-0 flex-1 basis-48',
          task.outcome === 'failed' ? 'text-critical' : task.done ? 'text-ink-faint' : 'text-ink-soft',
        )}
      >
        {parts.join(' · ')}
      </span>
      {/* Finished workflows leave the background list: the panel has nothing more to show. */}
      {!task.done ? (
        <button
          type="button"
          onClick={showAgentList}
          className="flex shrink-0 items-center gap-1.5 text-ink-faint hover:text-accent"
        >
          <CornerDownRight size={11} className="shrink-0" />
          {t('toolcall.workflow.view')}
        </button>
      ) : null}
    </div>
  )
}
