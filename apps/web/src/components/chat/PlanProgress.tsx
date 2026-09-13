import { Circle, CircleCheck, CircleDot } from 'lucide-react'
import type { PlanProgressItem } from '../../lib/chat-fold'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

export function PlanProgress({ item }: { item: PlanProgressItem }) {
  const t = useTranslate()
  if (item.items.length === 0) return null
  return (
    <div className="rounded-lg border border-line bg-surface/60 p-3">
      <p className="mb-2 text-xs font-medium text-ink-faint">{t('plan.progress.title')}</p>
      <ul className="flex flex-col gap-2">
        {item.items.map((step, index) => {
          const Icon = step.status === 'completed' ? CircleCheck : step.status === 'in_progress' ? CircleDot : Circle
          return (
            <li key={index} className="flex items-start gap-2 text-sm">
              <Icon size={14} className={cx('mt-0.5 shrink-0', step.status === 'in_progress' ? 'text-accent' : 'text-ink-faint')} aria-label={t(`plan.progress.${step.status}`)} />
              <span className={cx('min-w-0 break-words', step.status === 'completed' && 'text-ink-faint line-through')}>{step.text}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
