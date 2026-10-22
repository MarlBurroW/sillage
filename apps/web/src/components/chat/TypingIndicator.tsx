import type { TypingIndicatorStyle } from '../../lib/typing-indicator'
import { Logo } from '../Logo'
import { cx } from '../ui'

/** Thread and settings share artwork to keep previews faithful. */
export function TypingIndicator({
  variant,
  size = 22,
  className,
}: {
  variant: TypingIndicatorStyle
  size?: number
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cx('sg-typing-indicator', `sg-typing-${variant}`, className)}
      style={{ width: variant === 'ink' ? size * 1.5 : size, height: size }}
    >
      {variant === 'sillage' ? <Logo size={size} /> : null}
      {variant === 'wave' ? <>{[0, 1, 2, 3, 4].map((index) => <span key={index} />)}</> : null}
      {variant === 'orbit' ? (
        <svg viewBox="0 0 48 48" fill="none" focusable="false">
          <circle className="sg-typing-orbit-track" cx="24" cy="24" r="17" />
          <circle className="sg-typing-orbit-core" cx="24" cy="24" r="3" />
          <g className="sg-typing-orbit-points">
            <circle cx="24" cy="7" r="3.5" />
            <circle cx="24" cy="41" r="2.5" />
          </g>
        </svg>
      ) : null}
      {variant === 'ink' ? (
        <svg viewBox="0 0 76 48" fill="none" focusable="false">
          <path className="sg-typing-ink-track" d={INK_PATH} />
          <path className="sg-typing-ink-draw" pathLength="100" d={INK_PATH} />
        </svg>
      ) : null}
      {variant === 'constellation' ? (
        <svg viewBox="0 0 48 48" fill="none" focusable="false">
          <path d="m9 31 10-19 19 8-10 19-9-27m9 27L9 31l29-11" />
          <circle cx="9" cy="31" r="3" />
          <circle cx="19" cy="12" r="3.5" />
          <circle cx="38" cy="20" r="3" />
          <circle cx="28" cy="39" r="2.5" />
        </svg>
      ) : null}
      {variant === 'breath' ? (
        <>
          <span className="sg-typing-breath-ring" />
          <span className="sg-typing-breath-halo" />
          <span className="sg-typing-breath-core" />
        </>
      ) : null}
    </span>
  )
}

const INK_PATH = 'M4 28C14 28 12 11 22 11S29 37 39 37 45 20 56 20 63 28 72 28'
