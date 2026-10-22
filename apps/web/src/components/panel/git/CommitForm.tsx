import { GitCommitHorizontal, Loader } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent } from 'react'
import type { GitCommitResultDto, GitRepoStatusDto } from '@sillage/protocol'
import { useGitAction } from '../../../lib/git'
import { useTranslate } from '../../../lib/i18n'
import { Button } from '../../ui'
import { failureNotice, useGitPane } from './context'

const DRAFT_PREFIX = 'sillage.git.commitDraft:'

/**
 * Commit message and button beneath changes. Drafts survive Git tab unmounting during file
 * inspection, preserving written paragraphs, and are scoped so worktrees never share messages. With
 * unstaged changes and no index, offer stage-all-and-commit for common simple cases rather than
 * silently requiring index knowledge.
 */
export function CommitForm({ repo }: { repo: GitRepoStatusDto }) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const draftKey = DRAFT_PREFIX + scope
  const [message, setMessage] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? ''
    } catch {
      return ''
    }
  })
  const [amend, setAmend] = useState(false)
  const commit = useGitAction<
    { message: string; amend: boolean; stageAll: boolean },
    GitCommitResultDto
  >(scope, 'commit')

  useEffect(() => {
    try {
      if (message) sessionStorage.setItem(draftKey, message)
      else sessionStorage.removeItem(draftKey)
    } catch {
      /* Keep drafts in memory across tab use. */
    }
  }, [draftKey, message])

  const hasStaged = repo.staged.length > 0
  const canStageAll = repo.unstaged.length > 0
  // Unresolved conflicts block commits; explain before Git rejects them.
  const blocked = repo.conflicted.length > 0
  const ready =
    message.trim().length > 0 && !blocked && (hasStaged || canStageAll || amend) && !commit.isPending

  const submit = () => {
    if (!ready) return
    commit.mutate(
      { message, amend, stageAll: !hasStaged && canStageAll },
      {
        onSuccess: (result) => {
          setMessage('')
          setAmend(false)
          notify({ tone: 'positive', text: t('git.notice.committed', { hash: result.shortHash }) })
        },
        onError: (error) => notify(failureNotice(error, t('git.commit.failed'))),
      },
    )
  }

  /** Amending without a message starts with the latest commit message for optional editing. */
  const toggleAmend = () => {
    const next = !amend
    setAmend(next)
    if (next && message.trim() === '' && repo.head) {
      setMessage([repo.head.subject, repo.head.body].filter(Boolean).join('\n\n'))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  const label = amend
    ? t('git.commit.submitAmend')
    : hasStaged || !canStageAll
      ? t('git.commit.submit')
      : t('git.commit.submitAll')

  return (
    <form
      className="flex flex-col gap-2 border-b border-line/60 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        aria-label={t('git.commit.message')}
        placeholder={t('git.commit.placeholder')}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        className="max-h-60 min-h-16 w-full resize-y rounded-md border border-line bg-sunken px-2.5 py-2 text-[0.8125rem] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={amend}
            onChange={toggleAmend}
            // Repositories without commits have nothing to amend.
            disabled={!repo.head}
            className="accent-[var(--sg-accent)]"
          />
          {t('git.commit.amend')}
        </label>
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-ink-faint">
          {hasStaged
            ? repo.staged.length > 1
              ? t('git.commit.stagedMany', { count: repo.staged.length })
              : t('git.commit.stagedOne', { count: repo.staged.length })
            : null}
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={!ready}
          title={t('git.commit.shortcut')}
          icon={
            commit.isPending ? (
              <Loader size={14} className="animate-spin" />
            ) : (
              <GitCommitHorizontal size={14} />
            )
          }
        >
          {commit.isPending ? t('git.commit.pending') : label}
        </Button>
      </div>
    </form>
  )
}
