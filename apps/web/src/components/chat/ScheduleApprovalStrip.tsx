import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { ToolItem } from '../../lib/chat-fold'
import { useTranslate } from '../../lib/i18n'
import { useSchedules } from '../../lib/schedules'
import { scheduledTaskIdOf } from '../../lib/sillage-tools'
import { CheckApprovalDialog } from '../schedule/CheckSection'
import { outputText } from '../tools/payload'
import { Button } from '../ui'

/**
 * Below schedule_task calls proposing check scripts, offer approval without visiting task pages.
 * This is where users learn review is needed as the agent proposes it, avoiding silently skipped
 * tasks. Read task state so approval elsewhere appears here too.
 */
export function ScheduleApprovalStrip({ tool }: { tool: ToolItem }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const { data: schedules } = useSchedules()
  const taskId = scheduledTaskIdOf(outputText(tool.output))
  const task = taskId ? schedules?.find((entry) => entry.id === taskId) : undefined
  // Deleted task or removed script leaves nothing to approve.
  if (!task?.check) return null

  if (task.check.approved) {
    return (
      <div className="flex items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-[0.6875rem] text-positive">
        <ShieldCheck size={12} className="shrink-0" />
        {t('schedule.check.inlineApproved', { name: task.name })}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-caution/35 bg-caution/10 px-2.5 py-2 text-xs text-caution" data-check-approval>
      <ShieldAlert size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">{t('schedule.check.inlinePending', { name: task.name })}</span>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {t('schedule.check.review')}
      </Button>
      <CheckApprovalDialog task={task} open={open} onOpenChange={setOpen} />
    </div>
  )
}
