import { useState } from 'react'
import type { ConversationDto, WorktreeBulkCleanupItemDto, WorktreeStatusDto } from '@sillage/protocol'
import { translate, useTranslate } from '../lib/i18n'
import { isBulkCleanable, useBulkCleanWorktrees } from '../lib/worktrees'
import { Badge, Banner, ConfirmDialog, Switch, cx } from './ui'
import { WorktreeStateMark } from './WorktreeTag'

type Counted =
  | 'worktrees.bulk.confirm'
  | 'worktrees.bulk.selected'
  | 'worktrees.bulk.branches'
  | 'worktrees.bulk.sessions'
  | 'worktrees.bulk.done'

function plural(prefix: Counted, count: number): string {
  return translate(`${prefix}.${count > 1 ? 'many' : 'one'}`, { count })
}

const ACTIVE = new Set<ConversationDto['status']>(['running', 'awaiting_input'])

/**
 * One confirmation for every tree with nothing left to lose. Trees where a session is working stay
 * out of the selection and are listed with the reason; the server checks again on arrival, so this
 * list is a preview. Only sessions living in a tree are archived: a supervisor that merely wrote
 * there keeps going.
 */
export function WorktreeBulkCleanupDialog({
  projectId,
  trees,
  base,
  byId,
  onClose,
}: {
  projectId: string
  trees: WorktreeStatusDto[]
  base: string | null
  byId: Map<string, ConversationDto>
  onClose: () => void
}) {
  const t = useTranslate()
  const bulk = useBulkCleanWorktrees(projectId)

  // Frozen at opening: list refreshes while the dialog is open must not move rows under the pointer.
  const [{ ready, busy }] = useState(() => {
    const living = (tree: WorktreeStatusDto) =>
      tree.conversations
        .filter((entry) => entry.link === 'worktree')
        .map((entry) => byId.get(entry.id))
        .filter((conversation): conversation is ConversationDto => conversation !== undefined && conversation.archivedAt === null)
    const candidates = trees.filter(isBulkCleanable).map((tree) => ({ tree, living: living(tree) }))
    return {
      ready: candidates.filter((entry) => !entry.living.some((c) => ACTIVE.has(c.status))),
      busy: candidates.filter((entry) => entry.living.some((c) => ACTIVE.has(c.status))),
    }
  })
  const [selected, setSelected] = useState(() => new Set(ready.map((entry) => entry.tree.path)))
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [archiveSessions, setArchiveSessions] = useState(true)
  const [stopServices, setStopServices] = useState(true)

  const chosen = ready.filter((entry) => selected.has(entry.tree.path))
  const branches = chosen.filter((entry) => entry.tree.branch && entry.tree.branch !== base).length
  const sessions = chosen.reduce((sum, entry) => sum + entry.living.length, 0)
  const running = bulk.progress !== null
  const finished = bulk.items !== null

  const toggle = (path: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })

  return (
    <ConfirmDialog
      open
      size="wide"
      onOpenChange={(open) => { if (!open) onClose() }}
      title={t('worktrees.bulk.title')}
      confirmLabel={finished ? t('worktrees.bulk.close') : plural('worktrees.bulk.confirm', chosen.length)}
      busy={running}
      showCancel={!finished}
      confirmDisabled={!finished && chosen.length === 0}
      onConfirm={() => {
        if (finished) return onClose()
        void bulk.run(chosen.map((entry) => entry.tree.path), { deleteBranch, archiveSessions, stopServices })
      }}
    >
      {finished ? (
        <BulkSummary items={bulk.items ?? []} error={bulk.error} />
      ) : (
        <>
          <p>{base ? t('worktrees.bulk.intro', { base }) : t('worktrees.bulk.introNoBase')}</p>
          {running && bulk.progress ? (
            <p role="status" className="text-ink">
              {t('worktrees.bulk.progress', { done: bulk.progress.done, total: bulk.progress.total })}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
            <span>{plural('worktrees.bulk.selected', chosen.length)}</span>
            <button
              type="button"
              disabled={running}
              className="rounded-sm px-1 py-0.5 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => setSelected(chosen.length === ready.length ? new Set() : new Set(ready.map((entry) => entry.tree.path)))}
            >
              {chosen.length === ready.length ? t('worktrees.bulk.none') : t('worktrees.bulk.all')}
            </button>
          </div>
          <ul aria-label={t('worktrees.bulk.list')} className="flex flex-col divide-y divide-line rounded-sm border border-line">
            {ready.map(({ tree, living }) => (
              <li key={tree.path}>
                <label className={cx('flex min-h-11 cursor-pointer items-center gap-2.5 px-2.5 py-1.5', running && 'cursor-default opacity-70')}>
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--sg-accent)]"
                    checked={selected.has(tree.path)}
                    disabled={running}
                    onChange={(event) => toggle(tree.path, event.target.checked)}
                  />
                  <WorktreeStateMark state={tree.state} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-ink" title={tree.path}>{tree.name}</span>
                    <span className="block truncate text-[0.6875rem] text-ink-faint">
                      {[t(`worktrees.state.${tree.state}`), living.length ? plural('worktrees.bulk.sessions', living.length) : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {tree.external ? <Badge>{t('worktrees.external')}</Badge> : null}
                </label>
              </li>
            ))}
          </ul>
          {busy.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-ink-soft">{t('worktrees.bulk.busyTitle')}</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-ink-faint">
                {busy.map(({ tree }) => (
                  <li key={tree.path} className="truncate font-mono">{tree.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ul className="flex flex-col gap-1.5 pt-1">
            {branches > 0 ? (
              <BulkChoice label={plural('worktrees.bulk.branches', branches)} checked={deleteBranch} disabled={running} onChange={setDeleteBranch} />
            ) : null}
            {sessions > 0 ? (
              <BulkChoice
                label={plural('worktrees.bulk.sessions', sessions)}
                detail={t('worktrees.bulk.sessionsHint')}
                checked={archiveSessions}
                disabled={running}
                onChange={setArchiveSessions}
              />
            ) : null}
            <BulkChoice label={t('worktrees.bulk.services')} checked={stopServices} disabled={running} onChange={setStopServices} />
          </ul>
        </>
      )}
    </ConfirmDialog>
  )
}

function BulkSummary({ items, error }: { items: WorktreeBulkCleanupItemDto[]; error: string | null }) {
  const t = useTranslate()
  const removed = items.filter((item) => item.outcome === 'removed')
  const left = items.filter((item) => item.outcome !== 'removed')
  return (
    <>
      <p role="status" className="text-ink">{plural('worktrees.bulk.done', removed.length)}</p>
      {error ? <Banner>{t('worktrees.bulk.stopped', { message: error })}</Banner> : null}
      {left.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-ink-soft">{t('worktrees.bulk.leftTitle')}</p>
          <ul className="mt-1 flex flex-col gap-1 text-xs">
            {left.map((item) => (
              <li key={item.path} className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-ink">{item.name}</span>
                <span className="text-ink-faint">
                  {item.outcome === 'failed'
                    ? t('worktrees.bulk.failedItem', { message: item.message })
                    : item.reason === 'changed' && item.state
                      ? t('worktrees.bulk.reason.changed', { state: t(`worktrees.state.${item.state}`) })
                      : t(`worktrees.bulk.reason.${item.reason}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  )
}

function BulkChoice({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string
  detail?: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <li className="flex items-center gap-2">
      <Switch checked={checked} onCheckedChange={onChange} label={label} disabled={disabled} />
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {detail ? <span className="block text-xs text-ink-faint">{detail}</span> : null}
      </span>
    </li>
  )
}
