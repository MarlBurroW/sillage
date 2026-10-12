import { CalendarClock, KanbanSquare, Webhook } from 'lucide-react'
import type { DecisionDto, DecisionSourceKind } from '@sillage/protocol'
import type { translate } from '../../lib/i18n'
import { useTranslate } from '../../lib/i18n'
import { formatAgo } from '../../lib/loops'
import { cx } from '../ui'

const ICONS: Record<DecisionSourceKind, typeof Webhook> = {
  schedule: CalendarClock,
  webhook: Webhook,
  board: KanbanSquare,
}

/** D'où vient la demande : la tâche, l'automatisation ou l'issue, et le projet. */
export function DecisionSourceLine({ decision, className }: { decision: DecisionDto; className?: string }) {
  const t = useTranslate()
  const Icon = ICONS[decision.source.kind]
  return (
    <p className={cx('flex min-w-0 items-center gap-1.5 text-xs text-ink-faint', className)}>
      <Icon size={13} className="shrink-0" />
      <span className="truncate">
        {[decision.source.label, decision.projectName, t('decision.ago', { ago: formatAgo(Date.now() - decision.createdAt) })].filter(Boolean).join(' · ')}
      </span>
    </p>
  )
}

/** « Expire dans 23 h » ou « Expirée », pour une décision en attente. */
export function decisionDue(decision: DecisionDto, t: typeof translate): string {
  const left = decision.expiresAt - Date.now()
  return left > 0 ? t('decision.expiresIn', { left: formatAgo(left) }) : t('decision.expiring')
}
