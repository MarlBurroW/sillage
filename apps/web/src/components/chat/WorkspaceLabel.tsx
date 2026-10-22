import type { WorktreeDto } from '@sillage/protocol'
import { FolderGit2, GitBranch, TriangleAlert } from 'lucide-react'
import { useTranslate } from '../../lib/i18n'
import { setPanelOpen, setPanelTab } from '../../lib/panel'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui'

/**
 * Agent branch/worktree beside the project above the title, including at project root where the
 * main tree may be on an unexpected branch. Add worktree names only when different from branches to
 * avoid repetition. Clicking opens Git, the natural next destination.
 */
export function WorkspaceLabel({
  worktreeId,
  worktree,
  worktreesLoaded,
  projectGit,
  projectPath,
}: {
  worktreeId: string | null
  worktree: WorktreeDto | undefined
  worktreesLoaded: boolean
  projectGit: { branch: string; isDirty: boolean } | null | undefined
  projectPath: string | undefined
}) {
  const t = useTranslate()

  // Before list loading show nothing rather than a flashing missing warning.
  if (worktreeId && !worktreesLoaded) return null

  // Explain externally deleted directories or removed worktrees still targeted by threads: the
  // agent has no directory, not merely a hidden branch.
  if (worktreeId && !worktree?.git) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-critical">
        <TriangleAlert size={11} className="shrink-0" />
        <span className="truncate">{t('conversation.workspace.missing', { name: worktree?.name ?? '…' })}</span>
      </span>
    )
  }

  const git = worktree ? worktree.git : projectGit
  // Non-Git projects have no branch to display.
  if (!git) return null

  const detached = git.branch === 'HEAD'
  const branch = detached ? t('conversation.workspace.detached') : git.branch
  const extraName = worktree && worktree.name !== git.branch ? worktree.name : null
  const path = worktree?.path ?? projectPath
  const label = [
    worktree ? t('conversation.meta.worktree', { name: worktree.name }) : t('conversation.meta.projectFolder'),
    t('conversation.workspace.branch', { branch }),
    git.isDirty ? t('conversation.workspace.dirty') : null,
    path,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          setPanelTab('git')
          setPanelOpen(true)
        }}
        className="flex min-w-0 items-center gap-1 rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        {worktree ? <FolderGit2 size={11} className="shrink-0" /> : <GitBranch size={11} className="shrink-0" />}
        {extraName ? <span className="max-w-[40%] shrink-0 truncate">{extraName}</span> : null}
        {extraName ? <span className="shrink-0 opacity-60">/</span> : null}
        <span className={cx('min-w-0 truncate font-mono', detached && 'italic')}>{branch}</span>
        {git.isDirty ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-caution" /> : null}
      </button>
    </Tooltip>
  )
}
