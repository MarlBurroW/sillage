import { useId, type ReactNode } from 'react'
import { ChevronRight, ExternalLink } from 'lucide-react'
import type { ReleaseNote as ReleaseNoteData } from '@sillage/protocol'
import { locale } from '../lib/i18n'
import { releaseSummary } from '../lib/release-notes'
import { Markdown } from './chat/Markdown'
import { cx } from './ui'

/**
 * One release's notes, as GitHub publishes them (in English). Given `onToggle`, the row folds
 * down to its opening sentence, so a long history reads as a list of versions; without it the
 * notes are always shown, as on the About page before an update.
 */
export function ReleaseNote({
  release,
  badge,
  open = true,
  onToggle,
}: {
  release: ReleaseNoteData
  badge?: ReactNode
  open?: boolean
  onToggle?: () => void
}) {
  const bodyId = useId()
  const summary = onToggle && !open ? releaseSummary(release.body) : null
  const title = (
    <>
      {onToggle ? (
        <ChevronRight size={14} aria-hidden className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
      ) : null}
      <h3 className="text-sm font-semibold">{release.name}</h3>
      {badge}
    </>
  )
  return (
    <article className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <header className="flex items-center justify-between gap-2">
        {onToggle ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={onToggle}
            className="-mx-1 flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-high"
          >
            {title}
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-2">{title}</div>
        )}
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-xs text-ink-faint hover:text-ink"
        >
          <time dateTime={release.publishedAt}>{new Date(release.publishedAt).toLocaleDateString(locale())}</time>
          <ExternalLink size={12} />
        </a>
      </header>
      <div id={bodyId} className={cx(onToggle && 'pl-[1.375rem]')}>
        {open ? (
          <div className="mt-1.5"><Markdown text={release.body} /></div>
        ) : summary ? (
          <p className="mt-1 line-clamp-2 text-sm text-ink-faint">{summary}</p>
        ) : null}
      </div>
    </article>
  )
}
