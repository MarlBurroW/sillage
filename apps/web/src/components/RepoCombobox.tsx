import { GitBranch, Globe, Lock } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { GitRepoDto } from '@sillage/protocol'
import { useGitRepos } from '../lib/git-credentials'
import { useTranslate } from '../lib/i18n'
import { cx } from './ui'

/**
 * Repository-to-clone choice remains free text: suggestions only shortcut repositories visible to
 * the GitHub token. Accept pasted URLs from any forge or public repository. Do not open suggestions
 * when input already resembles a URL because no choice is needed.
 */
export function RepoCombobox({
  value,
  onChange,
  onPick,
  hasCredential,
  hint,
}: {
  value: string
  onChange: (value: string) => void
  onPick: (repo: GitRepoDto) => void
  hasCredential: boolean
  hint?: string
}) {
  const t = useTranslate()
  const id = useId()
  const list = useRef<HTMLUListElement>(null)

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const looksLikeUrl = /:\/\/|^[^\s/]+@[^\s/]+:/.test(value.trim())
  const listing = hasCredential && !looksLikeUrl
  const { data, isFetching } = useGitRepos(value.trim(), listing && open)
  const repos = data?.repos ?? []

  // New lists invalidate prior selection indices, which could otherwise submit a repository nobody chose.
  useEffect(() => setActive(0), [data])

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (repo: GitRepoDto) => {
    onPick(repo)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || repos.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (index + 1) % repos.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (index - 1 + repos.length) % repos.length)
    } else if (event.key === 'Enter') {
      const repo = repos[active]
      // With no targeted repository Enter submits the form because input may be a complete URL.
      if (repo) {
        event.preventDefault()
        pick(repo)
      }
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-soft">
        {t('clone.repo.label')}
      </label>

      <div className="relative">
        <div
          className={cx(
            'tap-target flex items-center gap-2 rounded-md border border-line bg-sunken px-3',
            'transition-colors focus-within:border-accent hover:border-line-strong',
          )}
        >
          <GitBranch size={15} className="shrink-0 text-ink-faint" />
          <input
            id={id}
            role="combobox"
            aria-expanded={open && listing}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            value={value}
            onChange={(event) => {
              onChange(event.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
            placeholder={t('clone.repo.placeholder')}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </div>

        {open && listing ? (
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={t('clone.repo.listAria')}
            className="surface absolute z-20 mt-1.5 max-h-64 w-full overflow-y-auto rounded-lg border border-line p-1 shadow-float"
          >
            {repos.map((repo, index) => (
              <li key={repo.fullName}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  // Use mousedown: click would blur the field and close suggestions before selection.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    pick(repo)
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    index === active ? 'bg-accent-wash text-ink' : 'text-ink-soft',
                  )}
                >
                  {repo.isPrivate ? (
                    <Lock size={13} className="shrink-0 text-ink-faint" />
                  ) : (
                    <Globe size={13} className="shrink-0 text-ink-faint" />
                  )}
                  <span className="shrink-0 font-medium">{repo.name}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-ink-faint">
                    {repo.description ?? repo.fullName}
                  </span>
                </button>
              </li>
            ))}

            {repos.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-ink-faint">
                {isFetching ? t('clone.repo.loading') : t('clone.repo.noMatch')}
              </li>
            ) : null}

            {data?.truncated ? (
              <li className="border-t border-line px-2 py-1.5 text-xs text-ink-faint">
                {t('clone.repo.truncated')}
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>

      {hint ? <p className="text-xs text-ink-faint">{hint}</p> : null}
    </div>
  )
}
