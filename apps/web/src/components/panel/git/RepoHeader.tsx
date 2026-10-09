import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  CloudDownload,
  Ellipsis,
  GitBranch,
  GitMerge,
  Loader,
  RefreshCw,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { GitActionDto, GitOperation, GitRepoStatusDto } from '@sillage/protocol'
import { useGitAction } from '../../../lib/git'
import { useTranslate, type MessageKey } from '../../../lib/i18n'
import { Button, IconButton, Menu, MenuItem, MenuSeparator, cx } from '../../ui'
import { failureNotice, useGitPane } from './context'

/**
 * La branche et sa relation au remote, avec les trois gestes qui les concernent :
 * fetch, pull, push.
 *
 * Les remèdes aux refus les plus courants sont proposés dans l'avis plutôt que cachés
 * dans un menu : un push rejeté offre de forcer avec bail, un pull qui trouve des
 * branches divergentes offre merge ou rebase. C'est ce qu'on taperait ensuite dans un
 * terminal, et c'est précisément ce que l'onglet veut épargner.
 */
export function RepoHeader({
  repo,
  refreshing,
  onRefresh,
}: {
  repo: GitRepoStatusDto
  refreshing: boolean
  onRefresh: () => void
}) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const fetch = useGitAction<void, GitActionDto>(scope, 'fetch')
  const pull = useGitAction<{ rebase?: boolean }, GitActionDto>(scope, 'pull')
  const push = useGitAction<{ force?: boolean }, GitActionDto>(scope, 'push')
  const stash = useGitAction<{ includeUntracked: boolean }, GitActionDto>(scope, 'stash')
  const busy = fetch.isPending || pull.isPending || push.isPending || stash.isPending

  const hasRemote = repo.remotes.length > 0
  const hasChanges = repo.staged.length + repo.unstaged.length > 0

  const report = (result: GitActionDto) =>
    notify(
      result.conflicts
        ? { tone: 'critical', text: t('git.notice.conflicts') }
        : { tone: 'positive', text: result.summary ?? t('git.notice.done') },
    )

  const doFetch = () =>
    fetch.mutate(undefined, {
      onSuccess: (result) => notify({ tone: 'positive', text: result.summary ?? t('git.notice.fetched') }),
      onError: (error) => notify(failureNotice(error, t('git.action.failed'))),
    })

  const doPull = (rebase?: boolean) =>
    pull.mutate(
      { rebase },
      {
        onSuccess: report,
        onError: (error) => {
          const notice = failureNotice(error, t('git.action.failed'))
          if (notice.code === 'git_pull_diverged') {
            notice.actions = [
              { label: t('git.action.pullMerge'), run: () => doPull(false) },
              { label: t('git.action.pullRebase'), run: () => doPull(true) },
            ]
          }
          notify(notice)
        },
      },
    )

  const doPush = (force = false) =>
    push.mutate(
      { force },
      {
        onSuccess: report,
        onError: (error) => {
          const notice = failureNotice(error, t('git.action.failed'))
          if (notice.code === 'git_push_rejected' && !force) {
            notice.actions = [{ label: t('git.action.pushForce'), run: () => doPush(true) }]
          }
          notify(notice)
        },
      },
    )

  const doStash = () =>
    stash.mutate(
      { includeUntracked: true },
      {
        onSuccess: (result) => notify({ tone: 'positive', text: result.summary ?? t('git.notice.done') }),
        onError: (error) => notify(failureNotice(error, t('git.action.failed'))),
      },
    )

  const name = repo.branch ?? (repo.detached ? t('git.header.detached') : t('git.header.unborn'))

  return (
    <div className="flex flex-col gap-1 border-b border-line px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranch size={13} className="shrink-0 text-ink-faint" />
        <span
          className={cx('min-w-0 truncate text-[0.8125rem] font-medium', repo.branch ? 'text-ink' : 'text-ink-soft italic')}
          title={name}
        >
          {name}
        </span>
        {repo.ahead > 0 ? (
          <Chip tone="text-positive" label={t('git.header.ahead', { count: repo.ahead })}>
            <ArrowUp size={10} />
            {repo.ahead}
          </Chip>
        ) : null}
        {repo.behind > 0 ? (
          <Chip tone="text-caution" label={t('git.header.behind', { count: repo.behind })}>
            <ArrowDown size={10} />
            {repo.behind}
          </Chip>
        ) : null}
        <span className="flex-1" />
        <IconButton label={t('git.action.refresh')} size="sm" onClick={onRefresh}>
          <RefreshCw size={13} className={cx(refreshing && 'animate-spin')} />
        </IconButton>
      </div>

      <div className="flex items-center gap-0.5">
        <span className="min-w-0 flex-1 truncate pl-0.5 text-[0.6875rem] text-ink-faint">
          {repo.upstream
            ? t('git.header.upstream', { upstream: repo.upstream })
            : hasRemote
              ? t('git.header.noUpstream')
              : t('git.header.noRemote')}
        </span>
        <Action
          label={t('git.action.fetch')}
          pending={fetch.isPending}
          disabled={busy || !hasRemote}
          onClick={doFetch}
        >
          <CloudDownload size={14} />
        </Action>
        <Action
          label={t('git.action.pull')}
          pending={pull.isPending}
          disabled={busy || !repo.upstream}
          onClick={() => doPull()}
        >
          <ArrowDownToLine size={14} />
        </Action>
        <Action
          label={repo.upstream ? t('git.action.push') : t('git.action.publish')}
          pending={push.isPending}
          disabled={busy || !hasRemote || repo.unborn || repo.detached}
          onClick={() => doPush()}
          badge={repo.ahead}
        >
          <ArrowUpFromLine size={14} />
        </Action>
        <Menu
          trigger={
            <IconButton label={t('git.action.more')} size="sm" disabled={busy}>
              <Ellipsis size={15} />
            </IconButton>
          }
        >
          <MenuItem icon={<GitMerge size={14} />} disabled={!repo.upstream} onSelect={() => doPull(false)}>
            {t('git.action.pullMerge')}
          </MenuItem>
          <MenuItem icon={<ArrowDownToLine size={14} />} disabled={!repo.upstream} onSelect={() => doPull(true)}>
            {t('git.action.pullRebase')}
          </MenuItem>
          <MenuItem icon={<Archive size={14} />} disabled={!hasChanges} onSelect={doStash}>
            {t('git.action.stash')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<ArrowUpFromLine size={14} />}
            tone="critical"
            disabled={!repo.upstream}
            onSelect={() => doPush(true)}
          >
            {t('git.action.pushForce')}
          </MenuItem>
        </Menu>
      </div>
    </div>
  )
}

function Chip({ tone, label, children }: { tone: string; label: string; children: ReactNode }) {
  return (
    <span
      className={cx('flex shrink-0 items-center gap-0.5 font-mono text-[0.625rem] tabular-nums', tone)}
      title={label}
      aria-label={label}
    >
      {children}
    </span>
  )
}

/** Un geste du remote : son icône, ou une roue tant qu'il tourne, et un décompte s'il a lieu. */
function Action({
  label,
  pending,
  disabled,
  badge = 0,
  onClick,
  children,
}: {
  label: string
  pending: boolean
  disabled: boolean
  badge?: number
  onClick: () => void
  children: ReactNode
}) {
  return (
    <span className="relative">
      <IconButton label={label} size="sm" disabled={disabled} onClick={onClick}>
        {pending ? <Loader size={14} className="animate-spin" /> : children}
      </IconButton>
      {badge > 0 && !pending ? (
        <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[0.5625rem] font-semibold text-accent-ink">
          {badge}
        </span>
      ) : null}
    </span>
  )
}

const OPERATION_LABELS: Record<GitOperation, MessageKey> = {
  merge: 'git.operation.merge',
  rebase: 'git.operation.rebase',
  'cherry-pick': 'git.operation.cherryPick',
  revert: 'git.operation.revert',
  bisect: 'git.operation.bisect',
}

/**
 * Une opération laissée en suspens par git : fusion, rebase, cherry-pick ou revert
 * arrêtés sur des conflits. Tant qu'elle dure, le dépôt n'est pas dans un état
 * ordinaire, et le bandeau tient les deux seules issues : abandonner, ou continuer une
 * fois les conflits résolus et ajoutés à l'index.
 */
export function OperationBanner({ repo }: { repo: GitRepoStatusDto }) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const abort = useGitAction(scope, 'abort')
  const proceed = useGitAction<void, GitActionDto>(scope, 'continue')
  const operation = repo.operation
  if (!operation) return null

  const conflicts = repo.conflicted.length
  const busy = abort.isPending || proceed.isPending
  const onError = (error: unknown) => notify(failureNotice(error, t('git.action.failed')))

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-caution/35 bg-caution/10 px-2.5 py-2 text-xs text-caution"
    >
      <AlertTriangle size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{t(OPERATION_LABELS[operation])}</span>
        <span className="text-ink-soft">
          {' · '}
          {conflicts === 0
            ? t('git.operation.resolved')
            : conflicts > 1
              ? t('git.operation.conflictsMany', { count: conflicts })
              : t('git.operation.conflictsOne', { count: conflicts })}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => abort.mutate(undefined, { onError })}
        >
          {t('git.operation.abort')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || conflicts > 0}
          onClick={() =>
            proceed.mutate(undefined, {
              onSuccess: (result) =>
                notify(
                  result.conflicts
                    ? { tone: 'critical', text: t('git.notice.conflicts') }
                    : { tone: 'positive', text: result.summary ?? t('git.notice.done') },
                ),
              onError,
            })
          }
        >
          {operation === 'merge' ? t('git.operation.commitMerge') : t('git.operation.continue')}
        </Button>
      </span>
    </div>
  )
}
