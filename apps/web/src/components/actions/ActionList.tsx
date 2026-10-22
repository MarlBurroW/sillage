import {
  ExternalLink,
  Loader,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCw,
  ScrollText,
  Server,
  ShieldQuestion,
  Square,
  SquareTerminal,
  Trash2,
  Zap,
} from 'lucide-react'
import { useState } from 'react'
import type { ProjectActionDto } from '@sillage/protocol'
import {
  actionView,
  describeActionState,
  useApproveAction,
  useDeleteAction,
  useRunAction,
} from '../../lib/actions'
import { useTranslate } from '../../lib/i18n'
import { showTerminal } from '../../lib/panel'
import { Badge, Banner, Button, Card, ConfirmDialog, IconButton, Menu, MenuItem, MenuSeparator, cx } from '../ui'
import { ActionDialog } from './ActionDialog'

/**
 * Project actions in settings-list style. Each offers one named primary action matching state:
 * launch idle, stop services, view active task output, or review agent-proposed commands. Logs,
 * restart, and editing remain in menus. Shared by panel tab and header launcher.
 */
export interface ActionHandlers {
  onReview: (action: ProjectActionDto) => void
  onEdit: (action: ProjectActionDto) => void
  onDelete: (action: ProjectActionDto) => void
}

export function ActionList({
  actions,
  conversationId,
  handlers,
  compact = false,
}: {
  actions: ProjectActionDto[]
  /** Narrow launcher layout with tighter spacing and icon-only primary actions. */
  compact?: boolean
  /** Conversation actions run within its worktree. */
  conversationId?: string
  handlers: ActionHandlers
}) {
  const run = useRunAction()

  const primary = (action: ProjectActionDto) => {
    const view = actionView(action)
    if (view.primary === 'review') handlers.onReview(action)
    else if (view.primary === 'output' && action.lastRun) showTerminal(action.lastRun.terminalId)
    else run.mutate({ action, op: view.primary === 'stop' ? 'stop' : 'run', conversationId })
  }

  return (
    <>
      {run.error ? (
        <div className="px-3 pt-2">
          <Banner>{run.error.message}</Banner>
        </div>
      ) : null}

      <ul className={cx('flex flex-col', compact ? '' : 'gap-2 p-3')}>
        {actions.map((action) => (
          <ActionRow
            key={action.id}
            action={action}
            busy={run.isPending && run.variables?.action.id === action.id}
            compact={compact}
            onPrimary={() => primary(action)}
            onRun={(op) => run.mutate({ action, op, conversationId })}
            onEdit={() => handlers.onEdit(action)}
            onDelete={() => handlers.onDelete(action)}
          />
        ))}
      </ul>
    </>
  )
}

/**
 * Review/edit/delete dialogs belong to list hosts. Launcher lists live in popovers closed by dialog
 * clicks; dialogs owned by the list would disappear too.
 */
export function useActionDialogs(projectId: string, conversationId?: string) {
  const t = useTranslate()
  const run = useRunAction()
  const approve = useApproveAction()
  const remove = useDeleteAction()
  const [reviewing, setReviewing] = useState<ProjectActionDto | null>(null)
  const [deleting, setDeleting] = useState<ProjectActionDto | null>(null)
  const [editing, setEditing] = useState<ProjectActionDto | 'new' | null>(null)
  const failure = approve.error ?? remove.error ?? run.error

  const handlers: ActionHandlers = {
    onReview: setReviewing,
    onEdit: setEditing,
    onDelete: setDeleting,
  }

  const dialogs = (
    <>
      {editing ? (
        <ActionDialog
          projectId={projectId}
          action={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        open={reviewing !== null}
        onOpenChange={(open) => { if (!open) setReviewing(null) }}
        title={t('actions.review.title', { label: reviewing?.label ?? '' })}
        confirmLabel={t('actions.review.confirm')}
        busy={approve.isPending}
        onConfirm={() => {
          const action = reviewing
          setReviewing(null)
          if (!action) return
          approve.mutate(action.id, {
            onSuccess: (approved) => run.mutate({ action: approved, conversationId }),
          })
        }}
      >
        <p>
          {t(reviewing?.kind === 'service' ? 'actions.review.bodyService' : 'actions.review.bodyTask', {
            title: reviewing?.agentConversationTitle ?? t('actions.proposedInGone'),
          })}
        </p>
        <pre className="max-h-48 overflow-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-ink">
          {reviewing?.subdir ? `${reviewing.subdir}/ $ ` : '$ '}
          {reviewing?.command}
        </pre>
        {reviewing?.url ? (
          <p className="text-xs text-ink-faint">{t('actions.opensAt', { url: reviewing.url })}</p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null) }}
        title={t('actions.delete.title', { label: deleting?.label ?? '' })}
        confirmLabel={t('actions.delete.confirm')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id)
          setDeleting(null)
        }}
      >
        <p>{t(deleting?.kind === 'service' ? 'actions.delete.bodyService' : 'actions.delete.bodyTask')}</p>
      </ConfirmDialog>
    </>
  )

  return { handlers, create: () => setEditing('new'), dialogs, failure }
}

type RunOp = 'run' | 'stop' | 'restart' | 'logs'

const PRIMARY = {
  review: { label: 'actions.review', icon: <ShieldQuestion size={14} /> },
  run: { label: 'actions.run', icon: <Play size={14} /> },
  stop: { label: 'actions.stop', icon: <Square size={13} /> },
  output: { label: 'actions.showOutput', icon: <SquareTerminal size={14} /> },
} as const

/**
 * Settings-style action row: icon tile, name, badges, command, status, primary named button, and
 * secondary menu.
 */
function ActionRow({
  action,
  busy,
  compact,
  onPrimary,
  onRun,
  onEdit,
  onDelete,
}: {
  action: ProjectActionDto
  busy: boolean
  compact: boolean
  onPrimary: () => void
  onRun: (op: RunOp) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const view = actionView(action)
  const isService = action.kind === 'service'
  const primary = PRIMARY[view.primary]

  const body = (
        <div className={cx('flex items-start gap-3', compact ? 'px-3 py-2.5' : 'px-5 py-4')}>
          <span
            className={cx(
              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md',
              view.live ? 'bg-positive/15 text-positive' : 'bg-accent-wash text-accent',
            )}
          >
            {isService ? <Server size={15} /> : <Zap size={15} />}
          </span>

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{action.label}</span>
              {action.status === 'proposed' ? <Badge tone="caution">{t('actions.badge.proposed')}</Badge> : null}
              {isService && view.live ? <Badge tone="positive">{t('actions.badge.running')}</Badge> : null}
              {view.failed ? <Badge tone="critical">{t('actions.badge.failed')}</Badge> : null}
            </div>
            {compact ? null : (
              <p title={action.command} className="truncate font-mono text-xs text-ink-faint">
                {action.subdir ? `${action.subdir}/ · ` : ''}
                {action.command}
              </p>
            )}
            {view.href ? (
              <a
                href={view.href}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-1 text-xs text-accent hover:underline"
              >
                <span className="truncate">{view.href.replace(/^https?:\/\//, '')}</span>
                <ExternalLink size={12} className="shrink-0" />
              </a>
            ) : null}
            <p className="text-xs text-ink-faint">{describeActionState(action, t)}</p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`${t(primary.label)} : ${action.label}`}
              icon={busy ? <Loader size={14} className="animate-spin" /> : primary.icon}
              onClick={onPrimary}
            >
              <span className={cx(compact && 'sr-only')}>{t(primary.label)}</span>
            </Button>
            <Menu trigger={<IconButton label={t('actions.more')} size="sm"><MoreHorizontal size={16} /></IconButton>}>
              {isService && view.live ? (
                <MenuItem icon={<RotateCw size={15} />} onSelect={() => onRun('restart')}>
                  {t('actions.restart')}
                </MenuItem>
              ) : null}
              {isService && (view.live || view.failed) ? (
                <MenuItem icon={<ScrollText size={15} />} onSelect={() => onRun('logs')}>
                  {t('actions.logs')}
                </MenuItem>
              ) : null}
              {!isService && action.lastRun ? (
                <MenuItem icon={<SquareTerminal size={15} />} onSelect={() => showTerminal(action.lastRun!.terminalId)}>
                  {t('actions.showOutput')}
                </MenuItem>
              ) : null}
              <MenuItem icon={<Pencil size={15} />} onSelect={onEdit}>
                {t('actions.edit')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 size={15} />} tone="critical" onSelect={onDelete}>
                {t('actions.delete')}
              </MenuItem>
            </Menu>
          </div>
        </div>
  )

  // Launcher cards would stack boxes inside a box: preserve anatomy with separator lines instead.
  return compact ? <li className="border-b border-line last:border-b-0">{body}</li> : <li><Card>{body}</Card></li>
}
