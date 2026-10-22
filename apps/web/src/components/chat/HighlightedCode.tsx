import { useEffect, useState } from 'react'
import { highlight, isHighlighterReady, loadHighlighter } from '../../lib/highlight'
import { cx } from '../ui'

/**
 * Highlighted code in pre tags. Lazy-load the library, showing first blocks plainly before
 * highlighting rather than delaying text during download.
 */
export function HighlightedCode({
  code,
  language,
  wrap = false,
  className,
}: {
  code: string
  /** Empty, unknown, or oversized code stays unhighlighted. */
  language: string
  wrap?: boolean
  className?: string
}) {
  const [rendered, setRendered] = useState(() => highlight(code, language))

  useEffect(() => {
    setRendered(highlight(code, language))
    if (isHighlighterReady()) return

    let cancelled = false
    void loadHighlighter().then(() => {
      if (!cancelled) setRendered(highlight(code, language))
    })
    return () => {
      cancelled = true
    }
  }, [code, language])

  return (
    <pre className={cx('overflow-x-auto', wrap && 'break-words whitespace-pre-wrap', className)}>
      {rendered.applied ? (
        // hljs spans use theme tokens from index.css.
        <code className="hljs" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      ) : (
        // Render as text and let React escape, requiring no manual sanitization.
        <code>{code}</code>
      )}
    </pre>
  )
}
