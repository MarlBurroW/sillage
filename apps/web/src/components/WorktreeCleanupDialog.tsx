import { useEffect, useState } from 'react'
import type { WorktreeStatusDto } from '@sillage/protocol'
import { ApiRequestError } from '../lib/api'
import { useUpdateCard } from '../lib/cards'
import { translate, useTranslate } from '../lib/i18n'
import { useCleanWorktree, useWorktreeCleanupPlan } from '../lib/worktrees'
import { Banner, ConfirmDialog, Switch, cx } from './ui'

function plural(prefix: 'worktrees.modified' | 'worktrees.untracked' | 'worktrees.clean.sessions' | 'worktrees.clean.services' | 'worktrees.clean.terminals', count: number): string {
  return translate(`${prefix}.${count > 1 ? 'many' : 'one'}`, { count })
}

/**
 * Cleanup confirmation explains losses and independently optional accompanying actions. Reread
 * plans on opening because active processes and sessions change. Move cards to Done through normal
 * client board actions, preserving human column choices and standard GitHub synchronization.
 */
export function WorktreeCleanupDialog({
  projectId,
  tree,
  base,
  onClose,
}: {
  projectId: string
  tree: WorktreeStatusDto
  base: string | null
  onClose: () => void
}) {
  const t = useTranslate()
  const { data: plan, isPending: loading, error: planError } = useWorktreeCleanupPlan(projectId, tree.path)
  const clean = useCleanWorktree(projectId)
  const updateCard = useUpdateCard(projectId)
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [archiveSessions, setArchiveSessions] = useState(true)
  const [stopServices, setStopServices] = useState(true)
  const [cardDone, setCardDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Offer Done for open cards without imposing it: unchecked by default.
  useEffect(() => { setCardDone(false) }, [plan?.card?.id])

  const lost: string[] = []
  if (plan) {
    if (plan.modified > 0) lost.push(plural('worktrees.modified', plan.modified))
    if (plan.untracked > 0) lost.push(plural('worktrees.untracked', plan.untracked))
    if (plan.state === 'unmerged' && plan.ahead > 0 && base) {
      lost.push(translate(plan.ahead > 1 ? 'worktrees.clean.lostCommits.many' : 'worktrees.clean.lostCommits.one', { count: plan.ahead, base }))
    }
  }
  const destructive = lost.length > 0 || (plan?.state === 'dirty')

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={t('worktrees.clean.title', { name: tree.name })}
      confirmLabel={t('worktrees.clean.confirm')}
      tone={destructive ? 'critical' : 'accent'}
      busy={!plan || clean.isPending || updateCard.isPending}
      onConfirm={() => {
        if (!plan) return
        setError(null)
        clean.mutate(
          { path: plan.path, deleteBranch: deleteBranch && plan.branchDeletable, archiveSessions, stopServices },
          {
            onSuccess: () => {
              if (cardDone && plan.card) updateCard.mutate({ id: plan.card.id, column: 'done' })
              onClose()
            },
            onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
          },
        )
      }}
    >
      {!plan ? (
        planError ? <Banner>{t('worktrees.clean.failed', { message: planError.message })}</Banner> :
          <p className="text-ink-faint">{loading ? t('worktrees.clean.loading') : null}</p>
      ) : (
        <>
          <p>{plan.state === 'missing' ? t('worktrees.clean.missingFolder') : t('worktrees.clean.intro')}</p>
          {lost.length > 0 ? (
            <Banner tone="critical">
              <span className="font-medium">{t('worktrees.clean.lost')}</span>
              {' · '}
              {lost.join(' · ')}
            </Banner>
          ) : plan.state !== 'missing' ? (
            <p className="text-ink-faint">{t('worktrees.clean.nothingLost')}</p>
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {plan.branch ? (
              <CleanupChoice
                label={plan.branchDeletable ? t('worktrees.clean.branch', { branch: plan.branch }) : t('worktrees.clean.branchBase')}
                checked={deleteBranch && plan.branchDeletable}
                disabled={!plan.branchDeletable}
                onChange={setDeleteBranch}
              />
            ) : null}
            {plan.conversations.length > 0 ? (
              <CleanupChoice
                label={plural('worktrees.clean.sessions', plan.conversations.length)}
                detail={plan.conversations.map((c) => c.title).join(', ')}
                checked={archiveSessions}
                onChange={setArchiveSessions}
              />
            ) : null}
            {plan.services.length > 0 ? (
              <CleanupChoice
                label={plural('worktrees.clean.services', plan.services.length)}
                detail={plan.services.map((s) => s.label).join(', ')}
                checked={stopServices}
                onChange={setStopServices}
              />
            ) : null}
            {plan.card ? (
              <CleanupChoice
                label={t('worktrees.clean.card', { number: plan.card.number })}
                detail={plan.card.title}
                checked={cardDone}
                onChange={setCardDone}
              />
            ) : null}
          </ul>
          {plan.terminals > 0 ? (
            <p className="text-ink-faint">{plural('worktrees.clean.terminals', plan.terminals)}</p>
          ) : null}
          {error ? <Banner>{t('worktrees.clean.failed', { message: error })}</Banner> : null}
        </>
      )}
    </ConfirmDialog>
  )
}

function CleanupChoice({
  label,
  detail,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  detail?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <li className="flex items-center gap-2">
      <Switch checked={checked} onCheckedChange={onChange} label={label} disabled={disabled} />
      <span className="min-w-0 flex-1">
        <span className={cx('block', disabled && 'text-ink-faint')}>{label}</span>
        {detail ? <span className="block truncate text-xs text-ink-faint" title={detail}>{detail}</span> : null}
      </span>
    </li>
  )
}
