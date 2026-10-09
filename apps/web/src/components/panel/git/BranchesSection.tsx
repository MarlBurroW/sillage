import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ChevronRight,
  Copy,
  Ellipsis,
  GitBranch,
  GitMerge,
  Loader,
  Plus,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import type { GitActionDto, GitBranchDto, GitRemoteBranchDto, GitRepoStatusDto } from '@sillage/protocol'
import { copyText } from '../../../lib/clipboard'
import { relativeDate } from '../../../lib/dates'
import { useGitAction, useGitBranches } from '../../../lib/git'
import { useTranslate } from '../../../lib/i18n'
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Select,
  cx,
} from '../../ui'
import { failureNotice, useGitPane } from './context'
import { Section, useSectionOpen } from './Section'

/**
 * Les branches du dépôt, et ce qu'on en fait : en créer une, changer, fusionner,
 * supprimer.
 *
 * Changer de branche est explicite, par un bouton, jamais au clic sur la ligne : la
 * liste se parcourt sans risque, et un changement de branche qui touche cent fichiers
 * mérite un geste qu'on ne fait pas par mégarde. Une branche extraite dans un autre
 * worktree ne peut pas l'être ici : git le refuserait, on le montre d'avance.
 */
export function BranchesSection({ repo }: { repo: GitRepoStatusDto }) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const [open, toggle] = useSectionOpen('branches', false)
  const [creating, setCreating] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const branches = useGitBranches(scope, open)
  const checkout = useGitAction<{ ref: string }>(scope, 'checkout')
  const merge = useGitAction<{ ref: string }, GitActionDto>(scope, 'merge')
  const remove = useGitAction<{ name: string; force: boolean }>(scope, 'branches', { method: 'delete' })
  const stash = useGitAction<{ includeUntracked: boolean }, GitActionDto>(scope, 'stash')
  const [deleting, setDeleting] = useState<GitBranchDto | null>(null)
  const busy = checkout.isPending || merge.isPending || remove.isPending || stash.isPending

  const onError = (error: unknown) => notify(failureNotice(error, t('git.action.failed')))

  const switchTo = (ref: string) =>
    checkout.mutate(
      { ref },
      {
        onSuccess: () => notify(null),
        onError: (error) => {
          const notice = failureNotice(error, t('git.action.failed'))
          // Le remède habituel : mettre le travail de côté, changer, le reprendre plus tard.
          if (notice.code === 'git_dirty_worktree') {
            notice.actions = [
              {
                label: t('git.branches.stashAndSwitch'),
                run: () =>
                  stash.mutate(
                    { includeUntracked: true },
                    { onSuccess: () => switchTo(ref), onError },
                  ),
              },
            ]
          }
          notify(notice)
        },
      },
    )

  const mergeInto = (ref: string) =>
    merge.mutate(
      { ref },
      {
        onSuccess: (result) =>
          notify(
            result.conflicts
              ? { tone: 'critical', text: t('git.notice.conflicts') }
              : { tone: 'positive', text: result.summary ?? t('git.branches.merged', { name: ref }) },
          ),
        onError,
      },
    )

  const deleteBranch = (name: string, force: boolean) =>
    remove.mutate(
      { name, force },
      {
        onSuccess: () => notify(null),
        onError: (error) => {
          const notice = failureNotice(error, t('git.action.failed'))
          if (notice.code === 'git_branch_unmerged' && !force) {
            notice.actions = [{ label: t('git.branches.deleteForce'), run: () => deleteBranch(name, true) }]
          }
          notify(notice)
        },
        onSettled: () => setDeleting(null),
      },
    )

  const local = branches.data?.local ?? []
  const remote = branches.data?.remote ?? []

  return (
    <Section
      title={t('git.branches.title')}
      count={local.length}
      open={open}
      onToggle={toggle}
      actions={
        <IconButton
          label={t('git.action.newBranch')}
          size="sm"
          disabled={repo.unborn}
          onClick={() => {
            if (!open) toggle()
            setCreating(true)
          }}
        >
          <Plus size={14} />
        </IconButton>
      }
    >
      {creating ? (
        <CreateBranchForm
          repo={repo}
          names={local.map((branch) => branch.name)}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {branches.isPending ? (
        <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-ink-faint">
          <Loader size={11} className="animate-spin" />
          {t('git.branches.loading')}
        </p>
      ) : null}

      {branches.error ? (
        <div className="p-2">
          <Banner>{branches.error instanceof Error ? branches.error.message : t('git.action.failed')}</Banner>
        </div>
      ) : null}

      {branches.data && local.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('git.branches.empty')}</p>
      ) : null}

      {local.map((branch) => (
        <LocalBranchRow
          key={branch.name}
          branch={branch}
          current={repo.branch}
          busy={busy}
          onSwitch={() => switchTo(branch.name)}
          onMerge={() => mergeInto(branch.name)}
          onDelete={() => setDeleting(branch)}
        />
      ))}

      {remote.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setRemoteOpen((value) => !value)}
            aria-expanded={remoteOpen}
            className="flex h-8 w-full items-center gap-1.5 border-b border-line/60 bg-sunken/40 px-2.5 text-left hover:bg-surface-high"
          >
            <ChevronRight
              size={12}
              className={cx('shrink-0 text-ink-faint transition-transform', remoteOpen && 'rotate-90')}
            />
            <span className="text-[0.6875rem] font-medium text-ink-soft">{t('git.branches.remote')}</span>
            <span className="text-[0.625rem] tabular-nums text-ink-faint">{remote.length}</span>
          </button>
          {remoteOpen
            ? remote.map((branch) => (
                <RemoteBranchRow
                  key={branch.name}
                  branch={branch}
                  current={repo.branch}
                  busy={busy}
                  onSwitch={() => switchTo(branch.name)}
                  onMerge={() => mergeInto(branch.name)}
                />
              ))
            : null}
        </>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(value) => {
          if (!value) setDeleting(null)
        }}
        title={t('git.branches.delete.title', { name: deleting?.name ?? '' })}
        confirmLabel={t('git.branches.delete')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => deleting && deleteBranch(deleting.name, false)}
      >
        <p>{t('git.branches.delete.body')}</p>
      </ConfirmDialog>
    </Section>
  )
}

function Counts({ ahead, behind }: { ahead: number; behind: number }) {
  const t = useTranslate()
  if (!ahead && !behind) return null
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[0.625rem] tabular-nums">
      {ahead ? (
        <span className="flex items-center text-positive" title={t('git.header.ahead', { count: ahead })}>
          <ArrowUp size={10} />
          {ahead}
        </span>
      ) : null}
      {behind ? (
        <span className="flex items-center text-caution" title={t('git.header.behind', { count: behind })}>
          <ArrowDown size={10} />
          {behind}
        </span>
      ) : null}
    </span>
  )
}

function LocalBranchRow({
  branch,
  current,
  busy,
  onSwitch,
  onMerge,
  onDelete,
}: {
  branch: GitBranchDto
  current: string | null
  busy: boolean
  onSwitch: () => void
  onMerge: () => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const elsewhere = !branch.current && branch.worktreePath !== null

  return (
    <div className="group/branch flex items-center gap-0.5 border-b border-line/60 pr-1 hover:bg-surface-high">
      <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 pl-2.5">
        <GitBranch size={12} className={cx('shrink-0', branch.current ? 'text-accent' : 'text-ink-faint')} />
        <span
          className={cx('min-w-0 truncate text-[0.8125rem]', branch.current ? 'font-medium text-ink' : 'text-ink-soft')}
          title={branch.name}
        >
          {branch.name}
        </span>
        {branch.current ? <Badge tone="accent">{t('git.branches.current')}</Badge> : null}
        {elsewhere ? <Badge>{t('git.branches.inWorktree')}</Badge> : null}
        {branch.gone ? <Badge tone="caution">{t('git.branches.gone')}</Badge> : null}
        <Counts ahead={branch.ahead} behind={branch.behind} />
        <span className="hidden shrink-0 text-[0.625rem] text-ink-faint @min-[26rem]:inline">
          {relativeDate(branch.ts)}
        </span>
      </div>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/branch:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
        {!branch.current ? (
          <IconButton
            label={t('git.branches.switch', { name: branch.name })}
            size="sm"
            disabled={busy || elsewhere}
            onClick={onSwitch}
          >
            <ArrowRightLeft size={14} />
          </IconButton>
        ) : null}
        <Menu
          trigger={
            <IconButton label={t('git.branches.actions', { name: branch.name })} size="sm" disabled={busy}>
              <Ellipsis size={15} />
            </IconButton>
          }
        >
          <MenuItem
            icon={<GitMerge size={14} />}
            disabled={branch.current || !current}
            onSelect={onMerge}
          >
            {t('git.branches.merge', { current: current ?? 'HEAD' })}
          </MenuItem>
          <MenuItem icon={<Copy size={14} />} onSelect={() => void copyText(branch.name)}>
            {t('git.branches.copyName')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={14} />}
            tone="critical"
            disabled={branch.current || elsewhere}
            onSelect={onDelete}
          >
            {t('git.branches.delete')}
          </MenuItem>
        </Menu>
      </div>
    </div>
  )
}

function RemoteBranchRow({
  branch,
  current,
  busy,
  onSwitch,
  onMerge,
}: {
  branch: GitRemoteBranchDto
  current: string | null
  busy: boolean
  onSwitch: () => void
  onMerge: () => void
}) {
  const t = useTranslate()
  return (
    <div className="group/branch flex items-center gap-0.5 border-b border-line/60 pr-1 hover:bg-surface-high">
      <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 pl-5">
        <GitBranch size={12} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate text-[0.8125rem] text-ink-soft" title={branch.name}>
          {branch.name}
        </span>
        <span className="hidden shrink-0 text-[0.625rem] text-ink-faint @min-[26rem]:inline">
          {relativeDate(branch.ts)}
        </span>
      </div>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/branch:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
        <IconButton label={t('git.branches.checkoutRemote')} size="sm" disabled={busy} onClick={onSwitch}>
          <ArrowRightLeft size={14} />
        </IconButton>
        <Menu
          trigger={
            <IconButton label={t('git.branches.actions', { name: branch.name })} size="sm" disabled={busy}>
              <Ellipsis size={15} />
            </IconButton>
          }
        >
          <MenuItem icon={<GitMerge size={14} />} disabled={!current} onSelect={onMerge}>
            {t('git.branches.merge', { current: current ?? 'HEAD' })}
          </MenuItem>
          <MenuItem icon={<Copy size={14} />} onSelect={() => void copyText(branch.name)}>
            {t('git.branches.copyName')}
          </MenuItem>
        </Menu>
      </div>
    </div>
  )
}

/** Nouvelle branche : son nom, d'où elle part, et si l'on y passe tout de suite. */
function CreateBranchForm({
  repo,
  names,
  onClose,
}: {
  repo: GitRepoStatusDto
  names: string[]
  onClose: () => void
}) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const create = useGitAction<{ name: string; from?: string; checkout: boolean }>(scope, 'branches')
  const [name, setName] = useState('')
  const [from, setFrom] = useState(repo.branch ?? 'HEAD')
  const [switchTo, setSwitchTo] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const options = [
    ...(repo.branch ? [] : [{ value: 'HEAD', label: 'HEAD' }]),
    ...names.map((value) => ({ value, label: value })),
  ]

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    create.mutate(
      { name: trimmed, from: from === 'HEAD' ? undefined : from, checkout: switchTo },
      {
        onSuccess: () => {
          notify(null)
          onClose()
        },
        onError: (err) => setError(err instanceof Error ? err.message : t('git.action.failed')),
      },
    )
  }

  return (
    <form
      className="flex flex-col gap-2 border-b border-line/60 bg-sunken/40 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('worktree.branch.placeholder')}
        aria-label={t('git.branches.create.name')}
        className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[0.8125rem] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-faint">{t('git.branches.create.from')}</span>
        <Select value={from} onChange={setFrom} options={options} className="min-w-32 flex-1" />
      </div>
      <label className="flex items-center gap-1.5 text-xs text-ink-soft">
        <input
          type="checkbox"
          checked={switchTo}
          onChange={(event) => setSwitchTo(event.target.checked)}
          className="accent-[var(--sg-accent)]"
        />
        {t('git.branches.create.checkout')}
      </label>
      {error ? <p className="text-xs text-critical">{error}</p> : null}
      <div className="flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('dialog.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
          {create.isPending ? t('git.branches.create.pending') : t('git.branches.create.submit')}
        </Button>
      </div>
    </form>
  )
}
