import type { ContextState } from '../../lib/chat-fold'
import { cx } from '../ui'

/** Au-delà, la conversation approche de la compaction : le repère change de ton. */
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
 * Occupation de la fenêtre de contexte.
 *
 * Distincte du quota d'abonnement affiché en en-tête : celle-ci se vide à chaque
 * nouvelle conversation et décide du moment où il faudra compacter.
 */
/**
 * Indicateur, et rien d'autre : compacter se déclenche depuis le menu de la
 * conversation. Une jauge cliquable ne dit pas ce que le clic ferait, et la seule
 * façon de l'apprendre était de l'essayer sur une conversation en cours.
 */
export function ContextMeter({ context }: { context: ContextState }) {
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
        {/* Le tracé part de midi et tourne dans le sens horaire, d'où la rotation. */}
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
      {percent} %
    </span>
  )
}
