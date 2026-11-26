import { Loader } from 'lucide-react'
import { requestReveal } from '../../../lib/editor-reveal'
import { fileIconUrl } from '../../../lib/file-icons'
import { useTranslate } from '../../../lib/i18n'
import { useDebounced } from '../../../lib/search'
import { useContentSearch, useFileSearch } from '../../../lib/tree'
import { EntryRow } from './EntryRow'
import type { Actions } from './shared'

/**
 * Lines containing the query, grouped by file. Each opens its file at the line, the match
 * selected. Plain buttons rather than tree rows: they are places in files, not entries.
 */
export function ContentResults({ scope, query, actions }: { scope: string; query: string; actions: Actions }) {
  const t = useTranslate()
  // Searching contents costs more than names: wait for a longer pause in typing.
  const settled = useDebounced(query, 250)
  const { data, isPending, error } = useContentSearch(scope, settled)

  if (error) {
    return <p className="px-2 py-1.5 text-xs text-critical">{error instanceof Error ? error.message : t('filetree.search.error')}</p>
  }
  if (isPending) {
    return (
      <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-ink-faint">
        <Loader size={11} className="animate-spin" />
        {t('filetree.search.loading')}
      </p>
    )
  }
  if (data.files.length === 0) return <p className="px-2 py-1.5 text-xs text-ink-faint">{t('filetree.content.empty')}</p>

  return (
    <ul aria-label={t('filetree.content.results')}>
      {data.files.map((file) => {
        const slash = file.path.lastIndexOf('/')
        return (
          <li key={file.path} className="pb-1">
            <div className="flex min-w-0 items-center gap-1.5 px-2 pt-1 text-[0.75rem]" title={file.path}>
              <img src={fileIconUrl(file.path.slice(slash + 1), false)} alt="" aria-hidden className="size-4 shrink-0" />
              <span className="shrink-0 text-ink-soft">{file.path.slice(slash + 1)}</span>
              <span className="min-w-0 truncate text-ink-faint">{slash > 0 ? file.path.slice(0, slash) : ''}</span>
            </div>
            <ul>
              {file.matches.map((match) => (
                <li key={match.line}>
                  <button
                    type="button"
                    aria-label={t('filetree.content.match', { line: match.line, path: file.path })}
                    onClick={() => {
                      requestReveal(scope, file.path, { line: match.line, column: match.column, length: match.length })
                      actions.open(file.path, true)
                    }}
                    className="flex w-full min-w-0 items-baseline gap-2 py-0.5 pr-2 pl-7 text-left font-mono text-[0.75rem] hover:bg-surface-high focus-visible:-outline-offset-2"
                  >
                    <span className="w-7 shrink-0 text-right text-ink-faint">{match.line}</span>
                    <span className="min-w-0 truncate whitespace-pre text-ink-soft">
                      {match.text.slice(0, match.from)}
                      <mark className="rounded-sm bg-accent-wash text-ink">{match.text.slice(match.from, match.from + match.length)}</mark>
                      {match.text.slice(match.from + match.length)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        )
      })}
      {data.truncated ? <li className="px-2 py-1.5 text-[0.6875rem] text-ink-faint">{t('filetree.content.truncated')}</li> : null}
    </ul>
  )
}

/** Flat search results: full paths explain file origins better than indentation. */
export function SearchResults({
  scope,
  query,
  actions,
}: {
  scope: string
  query: string
  actions: Actions
}) {
  const t = useTranslate()
  // One search per pause in typing rather than per letter.
  const settled = useDebounced(query, 150)
  const { data, isPending, error } = useFileSearch(scope, settled, { keepPrevious: true })

  if (error) {
    return (
      <p className="px-2 py-1.5 text-xs text-critical">
        {error instanceof Error ? error.message : t('filetree.search.error')}
      </p>
    )
  }

  if (isPending) {
    return (
      <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-ink-faint">
        <Loader size={11} className="animate-spin" />
        {t('filetree.search.loading')}
      </p>
    )
  }

  if (data.entries.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-ink-faint">{t('filetree.search.empty')}</p>
  }

  return (
    <ul role="tree" aria-label={t('filetree.title')} aria-multiselectable>
      {data.entries.map((entry) => (
        <li key={entry.path} role="none">
          <EntryRow entry={entry} actions={actions}>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-[0.8125rem] text-ink-soft">{entry.name}</span>
              <span className="truncate text-[0.6875rem] text-ink-faint">{entry.path}</span>
            </span>
          </EntryRow>
        </li>
      ))}

      {data.truncated ? (
        <li role="none" className="px-2 py-1.5 text-[0.6875rem] text-ink-faint">
          {t('filetree.search.truncated')}
        </li>
      ) : null}
    </ul>
  )
}
