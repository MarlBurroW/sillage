import { Check, ChevronRight, Loader, Minus, Plus, Undo2, FileCode } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { GitArea, GitChangeDto, GitRepoStatusDto } from '@sillage/protocol'
import { parseUnifiedDiff } from '../../../lib/diff'
import { useGitAction, useGitFileDiff } from '../../../lib/git'
import { useTranslate } from '../../../lib/i18n'
import { DiffHunks } from '../../DiffHunks'
import { Button, ConfirmDialog, IconButton, cx } from '../../ui'
import { CHANGE_KINDS, splitPath } from './change-kind'
import { CommitForm } from './CommitForm'
import { failureNotice, useGitPane } from './context'
import { Section, useSectionOpen } from './Section'

/**
 * Uncommitted work in conflict, staged, and unstaged groups, followed by commit form. Expose the
 * actual index rather than checkbox abstractions: users need it to choose commit contents and
 * abstractions leak through agent git add or formatting hooks.
 */
export function ChangesSection({ repo }: { repo: GitRepoStatusDto }) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const [open, toggle] = useSectionOpen('changes', true)
  const stage = useGitAction<{ paths?: string[] }>(scope, 'stage')
  const unstage = useGitAction<{ paths?: string[] }>(scope, 'unstage')
  const discard = useGitAction<{ paths: string[] }>(scope, 'discard')
  /** Changes proposed for discard, awaiting confirmation. */
  const [discarding, setDiscarding] = useState<GitChangeDto[] | null>(null)
  const busy = stage.isPending || unstage.isPending || discard.isPending

  const onError = (error: unknown) => notify(failureNotice(error, t('git.changes.failed')))
  const total = repo.staged.length + repo.unstaged.length + repo.conflicted.length

  const confirmDiscard = () => {
    if (!discarding) return
    discard.mutate(
      { paths: discarding.map((change) => change.path) },
      { onError, onSettled: () => setDiscarding(null) },
    )
  }

  return (
    <Section title={t('git.changes.title')} count={total} open={open} onToggle={toggle}>
      {total === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('git.changes.none')}</p>
      ) : null}

      {repo.conflicted.length > 0 ? (
        <Group title={t('git.changes.conflicted')} changes={repo.conflicted} tone="text-critical">
          {(change) => (
            <ChangeRow
              key={change.path}
              change={change}
              area="unstaged"
              actions={
                <IconButton
                  label={t('git.changes.resolve')}
                  size="sm"
                  disabled={busy}
                  onClick={() => stage.mutate({ paths: [change.path] }, { onError })}
                >
                  <Check size={14} />
                </IconButton>
              }
            />
          )}
        </Group>
      ) : null}

      {repo.staged.length > 0 ? (
        <Group
          title={t('git.changes.staged')}
          changes={repo.staged}
          actions={
            <IconButton
              label={t('git.changes.unstageAll')}
              size="sm"
              disabled={busy}
              onClick={() => unstage.mutate({}, { onError })}
            >
              <Minus size={14} />
            </IconButton>
          }
        >
          {(change) => (
            <ChangeRow
              key={`${change.path}\0${change.oldPath ?? ''}`}
              change={change}
              area="staged"
              actions={
                <IconButton
                  label={t('git.changes.unstage')}
                  size="sm"
                  disabled={busy}
                  onClick={() => unstage.mutate({ paths: [change.path] }, { onError })}
                >
                  <Minus size={14} />
                </IconButton>
              }
            />
          )}
        </Group>
      ) : null}

      {repo.unstaged.length > 0 ? (
        <Group
          title={t('git.changes.unstaged')}
          changes={repo.unstaged}
          actions={
            <>
              <IconButton
                label={t('git.changes.discardAll')}
                size="sm"
                disabled={busy}
                onClick={() => setDiscarding(repo.unstaged)}
              >
                <Undo2 size={14} />
              </IconButton>
              <IconButton
                label={t('git.changes.stageAll')}
                size="sm"
                disabled={busy}
                onClick={() => stage.mutate({ paths: repo.unstaged.map((c) => c.path) }, { onError })}
              >
                <Plus size={14} />
              </IconButton>
            </>
          }
        >
          {(change) => (
            <ChangeRow
              key={change.path}
              change={change}
              area={change.kind === 'untracked' ? 'untracked' : 'unstaged'}
              actions={
                <>
                  <IconButton
                    label={t('git.changes.discard')}
                    size="sm"
                    disabled={busy}
                    onClick={() => setDiscarding([change])}
                  >
                    <Undo2 size={14} />
                  </IconButton>
                  <IconButton
                    label={t('git.changes.stage')}
                    size="sm"
                    disabled={busy}
                    onClick={() => stage.mutate({ paths: [change.path] }, { onError })}
                  >
                    <Plus size={14} />
                  </IconButton>
                </>
              }
            />
          )}
        </Group>
      ) : null}

      <CommitForm repo={repo} />

      <ConfirmDialog
        open={discarding !== null}
        onOpenChange={(value) => {
          if (!value) setDiscarding(null)
        }}
        title={
          discarding && discarding.length === 1
            ? t('git.changes.discard.title', { name: splitPath(discarding[0]!.path).name })
            : t('git.changes.discardAll.title')
        }
        confirmLabel={t('git.changes.discard.confirm')}
        tone="critical"
        busy={discard.isPending}
        onConfirm={confirmDiscard}
      >
        {discarding && discarding.length === 1 ? (
          <p>
            {discarding[0]!.kind === 'untracked'
              ? t('git.changes.discard.body.untracked')
              : t('git.changes.discard.body.tracked')}
          </p>
        ) : (
          <p>{t('git.changes.discardAll.body', { count: discarding?.length ?? 0 })}</p>
        )}
      </ConfirmDialog>
    </Section>
  )
}

function Group({
  title,
  changes,
  tone,
  actions,
  children,
}: {
  title: string
  changes: GitChangeDto[]
  tone?: string
  actions?: ReactNode
  children: (change: GitChangeDto) => ReactNode
}) {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle ? changes.filter((change) =>
      [change.path, change.oldPath].some((path) => path?.toLocaleLowerCase().includes(needle)),
    ) : changes
  }, [changes, query])
  // Bound rendering before rows and tooltips so thousands of untracked files cannot freeze the UI.
  const pageSize = 100
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const start = currentPage * pageSize
  return (
    <div data-git-change-group>
      <div className="flex items-center gap-1 border-b border-line/60 bg-sunken/40 py-0.5 pr-1 pl-2.5">
        <span className={cx('text-[0.6875rem] font-medium', tone ?? 'text-ink-soft')}>{title}</span>
        <span className="text-[0.625rem] tabular-nums text-ink-faint">{changes.length}</span>
        <span className="flex-1" />
        {actions}
      </div>
      {changes.length > pageSize || query ? (
        <input
          type="search"
          aria-label={t('git.changes.search')}
          placeholder={t('git.changes.search')}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(0) }}
          className="m-2 w-[calc(100%-1rem)] rounded border border-line bg-sunken px-2 py-1 text-xs text-ink"
        />
      ) : null}
      {filtered.slice(start, start + pageSize).map(children)}
      {filtered.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('git.changes.noResults')}</p>
      ) : null}
      {filtered.length > pageSize ? (
        <div className="flex flex-wrap items-center justify-between gap-1 p-2">
          <span className="text-xs text-ink-faint" aria-live="polite">
            {t('git.changes.range', { start: start + 1, end: Math.min(start + pageSize, filtered.length), total: filtered.length })}
          </span>
          <div className="flex gap-1">
            <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              {t('git.changes.previous')}
            </Button>
            <Button size="sm" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>
              {t('git.changes.next')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Changed file expandable to diff, with right-side actions visible on desktop hover/focus and
 * always on touch.
 */
function ChangeRow({
  change,
  area,
  actions,
}: {
  change: GitChangeDto
  area: GitArea
  actions: ReactNode
}) {
  const t = useTranslate()
  const { openFile } = useGitPane()
  const [open, setOpen] = useState(false)
  const kind = CHANGE_KINDS[change.kind]
  const { dir, name } = splitPath(change.path)

  return (
    <div className="border-b border-line/60">
      <div
        className="group/change flex items-center gap-0.5 pr-1 hover:bg-surface-high"
        data-path={change.path}
      >
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left"
        >
          <ChevronRight
            size={12}
            className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
          />
          <span
            className={cx('w-3 shrink-0 text-center font-mono text-[0.625rem] font-semibold', kind.tone)}
            title={t(kind.label)}
            aria-label={t(kind.label)}
          >
            {kind.letter}
          </span>
          <span className="min-w-0 flex-1 text-[0.8125rem]" title={change.path}>
            <span className="block truncate text-ink-soft">{name}</span>
            {dir ? <span className="block truncate text-[0.625rem] text-ink-faint">{dir}</span> : null}
            {change.oldPath ? (
              <span className="text-ink-faint"> · {t('git.changes.renamedFrom', { path: change.oldPath })}</span>
            ) : null}
          </span>
          {change.added ? (
            <span className="shrink-0 font-mono text-[0.625rem] text-positive">+{change.added}</span>
          ) : null}
          {change.removed ? (
            <span className="shrink-0 font-mono text-[0.625rem] text-critical">-{change.removed}</span>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/change:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          {openFile && change.kind !== 'deleted' ? (
            <IconButton label={t('git.changes.open')} size="sm" onClick={() => openFile(change.path)}>
              <FileCode size={14} />
            </IconButton>
          ) : null}
          {actions}
        </div>
      </div>

      {open ? <FileDiffBody path={change.path} area={area} /> : null}
    </div>
  )
}

/** Load file diffs only on expansion. */
function FileDiffBody({ path, area }: { path: string; area: GitArea }) {
  const t = useTranslate()
  const { scope } = useGitPane()
  const { data, error, isPending } = useGitFileDiff(scope, path, area, true)
  const file = useMemo(() => (data ? (parseUnifiedDiff(data.patch)[0] ?? null) : null), [data])

  return (
    <div className="border-t border-line/60 bg-sunken/40">
      {isPending ? (
        <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
          <Loader size={11} className="animate-spin" />
          {t('git.changes.diffLoading')}
        </p>
      ) : null}

      {error ? (
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-critical">
          {error instanceof Error ? error.message : t('changes.diff.error')}
        </p>
      ) : null}

      {data && (!file || file.hunks.length === 0) ? (
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
          {file?.status === 'binary' ? t('changes.file.binary') : t('git.changes.diffEmpty')}
        </p>
      ) : null}

      {file && file.hunks.length > 0 ? <DiffHunks hunks={file.hunks} path={path} /> : null}

      {data?.truncated ? (
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-caution">{t('changes.diff.truncated')}</p>
      ) : null}
    </div>
  )
}
