import type { ReactNode } from 'react'
import { HighlightedCode } from '../chat/HighlightedCode'
import { cx } from '../ui'

/**
 * Shared tool-view pieces keep labels, code blocks, and maximum heights consistent across tools.
 * Custom formatting per renderer would cost more consistency than it adds.
 */

/** Labeled block with hint for details not needing separate blocks. */
export function Section({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string | null
  /** Absent when label and hint already convey everything, such as file paths. */
  children?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-[0.6875rem] font-medium tracking-wide text-ink-faint uppercase">
          {label}
        </span>
        {hint ? (
          <span className="min-w-0 truncate font-mono text-[0.6875rem] text-ink-faint" title={hint}>
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/** Common frame for highlighted and plain content blocks. */
const FRAME = 'max-h-80 overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-xs'

export function Code({
  content,
  language,
  wrap = false,
}: {
  content: string
  language: string
  wrap?: boolean
}) {
  return <HighlightedCode code={content} language={language} wrap={wrap} className={FRAME} />
}

/** Plain command/search output without guessed highlighting, which would only reduce readability. */
export function Plain({ content, tone }: { content: string; tone?: string }) {
  return <pre className={cx(FRAME, 'break-words whitespace-pre-wrap', tone)}>{content}</pre>
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-line bg-sunken p-2 font-mono text-xs text-ink-faint">
      {children}
    </p>
  )
}
