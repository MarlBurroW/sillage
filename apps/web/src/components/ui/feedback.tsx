import { AlertTriangle, CircleAlert, CircleCheck, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from './cx'

type BannerTone = 'critical' | 'caution' | 'info' | 'positive'

const TONES: Record<BannerTone, { className: string; icon: ReactNode }> = {
  critical: {
    className: 'border-critical/35 bg-critical/10 text-critical',
    icon: <CircleAlert size={16} />,
  },
  caution: {
    className: 'border-caution/35 bg-caution/10 text-caution',
    icon: <AlertTriangle size={16} />,
  },
  info: {
    className: 'border-line bg-surface-high text-ink-soft',
    icon: <Info size={16} />,
  },
  positive: {
    className: 'border-positive/35 bg-positive/10 text-positive',
    icon: <CircleCheck size={16} />,
  },
}

export function Banner({ tone = 'critical', children }: { tone?: BannerTone; children: ReactNode }) {
  const { className, icon } = TONES[tone]
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cx('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', className)}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  )
}

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      {icon ? (
        <span className="flex size-12 items-center justify-center rounded-xl bg-surface-high text-ink-faint">
          {icon}
        </span>
      ) : null}
      <p className="font-medium text-ink-soft">{title}</p>
      {description ? (
        <div className="max-w-sm text-sm text-ink-faint">{description}</div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

type BadgeTone = 'neutral' | 'accent' | 'positive' | 'caution' | 'critical'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-high text-ink-faint',
  accent: 'bg-accent-wash text-accent',
  positive: 'bg-positive/15 text-positive',
  caution: 'bg-caution/15 text-caution',
  critical: 'bg-critical/15 text-critical',
}

export function Badge({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: BadgeTone
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
      )}
    >
      {icon}
      {children}
    </span>
  )
}
