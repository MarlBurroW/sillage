import type { ConversationDto, WorktreeState } from '@sillage/protocol'
import { useTranslate } from '../lib/i18n'
import { useConversationWorktree } from '../lib/worktrees'
import { cx } from './ui'

/** Worktree-state colors shared by sidebar and worktree overview so identical states have identical hues. */
export const WORKTREE_STATE_COLOR: Record<WorktreeState, string> = {
  missing: 'bg-critical',
  dirty: 'bg-caution',
  unmerged: 'bg-accent',
  merged: 'bg-positive',
}

export const WORKTREE_STATE_TONE: Record<WorktreeState, 'critical' | 'caution' | 'accent' | 'positive'> = {
  missing: 'critical',
  dirty: 'caution',
  unmerged: 'accent',
  merged: 'positive',
}

/** Solid square with sharp corners distinguishes tree state from circular current-activity signals. */
export function WorktreeStateMark({ state, className }: { state: WorktreeState; className?: string }) {
  return <span aria-hidden className={cx('size-1.5 shrink-0', WORKTREE_STATE_COLOR[state], className)} />
}

/**
 * Session branch and tree state beneath sidebar titles, omitted for main-tree sessions so others
 * stand out. The enclosing session link owns navigation; this label must not also open the panel.
 */
export function WorktreeTag({ conversation }: { conversation: Pick<ConversationDto, 'id' | 'projectId'> }) {
  const t = useTranslate()
  const tree = useConversationWorktree(conversation)
  if (!tree) return null

  const state = t(`worktrees.state.${tree.state}`)
  return (
    <span
      role="note"
      aria-label={t('shell.conversation.worktree', { name: tree.name, state })}
      title={`${tree.name} · ${state}\n${tree.path}`}
      className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.6875rem] leading-4 text-ink-faint"
    >
      <WorktreeStateMark state={tree.state} />
      <span className="min-w-0 truncate font-mono">{tree.name}</span>
      <span className="shrink-0">· {state}</span>
    </span>
  )
}
