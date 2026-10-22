import type { ContextState } from '../../lib/chat-fold'
import { cx } from '../ui'

/** Beyond this threshold compaction approaches and indicator tone changes. */
const WARN_RATIO = 0.75
const CRITICAL_RATIO = 0.9

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)} k`
  return `${(count / 1_000_000).toFixed(1)} M`
}

/**
 * Context-window usage distinct from subscription quota in the header: reset per conversation and
 * determines compaction timing.
 */
/**
 * Indicator only: compaction belongs to the conversation menu. Clickable gauges did not explain
 * their effect except by trying on active conversations.
 */
export function ContextMeter({ context, compact = false }: { context: ContextState; compact?: boolean }) {
  const ratio = Math.min(Math.max(context.ratio, 0), 1)
  const percent = Math.round(ratio * 100)

  const tone =
    ratio >= CRITICAL_RATIO ? 'text-critical' : ratio >= WARN_RATIO ? 'text-caution' : 'text-accent'

  return (
    <span
      className={cx('flex shrink-0 items-center gap-1.5 text-xs tabular-nums', tone)}
      title={`Contexte : ${formatTokens(context.usedTokens)} sur ${formatTokens(context.maxTokens)} tokens`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle
          cx="9"
          cy="9"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.22"
        />
        {/* Rotate to start at noon and proceed clockwise. */}
        <circle
          cx="9"
          cy="9"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          transform="rotate(-90 9 9)"
        />
      </svg>
      {/*
       * Phone ring only: percentages remain available through screen readers/tooltips without
       * consuming button space.
       */}
      {compact ? <span className="sr-only">{percent} %</span> : `${percent} %`}
    </span>
  )
}
