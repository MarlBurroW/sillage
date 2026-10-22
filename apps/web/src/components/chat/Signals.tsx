import {
  AlertTriangle,
  Bot,
  Hand,
  Hourglass,
  Layers,
  Pause,
  Repeat,
  Waves,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import type { Signal, SignalFamily, SignalKind } from '../../lib/signals'
import { cx } from '../ui'

/**
 * Shared conversation-signal rendering. One icon/color table makes consistency structural across
 * surfaces. Add signals here and in buildSignals to expose them everywhere.
 */

const ICONS: Record<SignalKind, LucideIcon> = {
  running: Bot,
  subagents: Bot,
  background: Waves,
  loop: Repeat,
  queued: Layers,
  awaiting: Hand,
  interrupted: Pause,
  pending: Hourglass,
  offline: WifiOff,
  error: AlertTriangle,
}

/** Colors belong to families, never individual signals: the palette rule. */
const TEXT: Record<SignalFamily, string> = {
  working: 'text-accent',
  scheduled: 'text-loop',
  awaiting: 'text-caution',
  broken: 'text-critical',
}

const DOT: Record<SignalFamily, string> = {
  working: 'bg-accent',
  scheduled: 'bg-loop',
  awaiting: 'bg-caution',
  broken: 'bg-critical',
}

/**
 * Animate only actual activity. Armed loops wait, errors are stationary, and awaiting answers needs
 * no movement.
 */
function pulses(signal: Signal): boolean {
  return signal.family === 'working'
}

export function SignalChip({ signal, onClick }: { signal: Signal; onClick?: () => void }) {
  const Icon = ICONS[signal.kind]
  const content = (
    <>
      <Icon size={11} className={cx('shrink-0', pulses(signal) && 'animate-pulse')} />
      <span className="truncate">{signal.label}</span>
    </>
  )
  const className = cx(
    'flex min-w-0 shrink items-center gap-1.5 text-[0.6875rem] font-medium',
    TEXT[signal.family],
  )
  const title = signal.detail || signal.label

  if (!onClick) {
    return (
      <span className={className} title={title}>
        {content}
      </span>
    )
  }

  return (
    <button type="button" onClick={onClick} title={title} className={cx(className, 'hover:underline')}>
      {content}
    </button>
  )
}

/**
 * Signals with detail destinations: Agents panel already lists subagent threads and background
 * work. Other signals have nothing beyond tooltips.
 */
const OPENS_PANEL = new Set<SignalKind>(['subagents', 'background'])

/** Signal row renders nothing when empty instead of a blank line. */
export function SignalRow({
  signals,
  onSelect,
  className,
}: {
  signals: Signal[]
  /** Called for navigable signals; others stay inert. */
  onSelect?: (kind: SignalKind) => void
  className?: string
}) {
  if (signals.length === 0) return null

  return (
    <div className={cx('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {signals.map((signal) => (
        <SignalChip
          key={signal.kind}
          signal={signal}
          onClick={onSelect && OPENS_PANEL.has(signal.kind) ? () => onSelect(signal.kind) : undefined}
        />
      ))}
    </div>
  )
}

/** Same vocabulary reduced to one dot where space is limited. */
export function SignalDot({ signal }: { signal: Signal }) {
  return (
    <span
      aria-label={signal.label}
      title={signal.detail || signal.label}
      className={cx('size-1.5 rounded-full', DOT[signal.family], pulses(signal) && 'animate-pulse')}
    />
  )
}
