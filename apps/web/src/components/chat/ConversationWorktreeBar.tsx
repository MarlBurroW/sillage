import { BrushCleaning, FileCheck, FolderGit2, GitBranch } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ConversationDto } from '@sillage/protocol'
import { translate, useTranslate } from '../../lib/i18n'
import { setPanelOpen, setPanelTab } from '../../lib/panel'
import { useConversationWorktree, useWorktreeStatuses } from '../../lib/worktrees'
import { WorktreeCleanupDialog } from '../WorktreeCleanupDialog'
import { WorktreeLeftoversDialog } from '../WorktreeLeftoversDialog'
import { WorktreeStateMark } from '../WorktreeTag'
import { IconButton } from '../ui'

/** Worktree state stays near the thread; cleanup is not an agent request. */
export function ConversationWorktreeBar({ conversation, canClean }: { conversation: ConversationDto; canClean: boolean }) {
  const t = useTranslate()
  const tree = useConversationWorktree(conversation)
  const { data } = useWorktreeStatuses(conversation.projectId)
  const [cleaningPath, setCleaningPath] = useState<string | null>(null)
  const [reviewingPath, setReviewingPath] = useState<string | null>(null)
  const base = data?.base ?? null
  const workingHere = tree?.conversations.some((entry) => entry.id === conversation.id && entry.link === 'worktree')
  // Deleted trees may remain session cwd: report even when absent from Git. Formerly edited-only
  // trees need no lingering display.
  if (!conversation.projectId) return null
  if (!tree && (!conversation.worktreeId || !data)) return null

  const state = tree
    ? [
        tree.state === 'merged' && base ? t('worktrees.conversation.merged', { base }) : t(`worktrees.state.${tree.state}`),
        tree.kept > 0 ? translate(tree.kept > 1 ? 'worktrees.kept.many' : 'worktrees.kept.one', { count: tree.kept }) : null,
      ].filter(Boolean).join(' · ')
    : t('worktrees.conversation.missing')
  const canOpenGit = workingHere && tree?.state !== 'missing'
  return (
    <section
      aria-label={t('worktrees.conversation.label')}
      className="flex min-h-9 shrink-0 items-center gap-2 border-b border-line bg-sunken/40 px-3 text-xs @min-[44rem]/thread:px-4"
    >
      {tree ? <WorktreeStateMark state={tree.state} /> : <FolderGit2 size={12} className="shrink-0 text-critical" />}
      <Link
        to={`/p/${conversation.projectId}#worktrees`}
        title={tree ? `${workingHere ? tree.name : t('worktrees.conversation.edited', { name: tree.name })}\n${tree.path}` : t('worktrees.conversation.overview')}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-sm @min-[44rem]/thread:flex-row @min-[44rem]/thread:items-center @min-[44rem]/thread:gap-2 text-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        {tree ? <span className="max-w-full min-w-0 truncate font-mono">{tree.branch ?? tree.name}</span> : null}
        <span className="max-w-full truncate text-[0.6875rem] text-ink-faint">{state}</span>
      </Link>
      {canOpenGit ? (
        <IconButton size="sm" label={t('worktrees.conversation.git')} onClick={() => { setPanelTab('git'); setPanelOpen(true) }}>
          <GitBranch size={14} />
        </IconButton>
      ) : null}
      {canClean && tree?.state === 'leftovers' ? (
        <button
          type="button"
          onClick={() => setReviewingPath(tree.path)}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-sm px-2 text-ink-soft hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent md:h-8 pointer-coarse:h-11"
        >
          <FileCheck size={13} />
          {t('worktrees.leftovers.review')}
        </button>
      ) : null}
      {canClean && tree && (tree.state === 'merged' || tree.state === 'missing') ? (
        <button
          type="button"
          onClick={() => setCleaningPath(tree.path)}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-sm px-2 text-ink-soft hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent md:h-8 pointer-coarse:h-11"
        >
          <BrushCleaning size={13} />
          {t('worktrees.clean')}
        </button>
      ) : null}
      {tree && reviewingPath === tree.path ? (
        <WorktreeLeftoversDialog projectId={conversation.projectId} tree={tree} base={base} onClose={() => setReviewingPath(null)} />
      ) : null}
      {tree && cleaningPath === tree.path ? (
        <WorktreeCleanupDialog projectId={conversation.projectId} tree={tree} base={base} onClose={() => setCleaningPath(null)} />
      ) : null}
    </section>
  )
}
