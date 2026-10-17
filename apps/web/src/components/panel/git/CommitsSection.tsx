import {
  Copy,
  Ellipsis,
  GitBranchPlus,
  Loader,
  RotateCcw,
  Tag,
  Undo2,
  X,
  Search,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CommitDto, GitActionDto, GitRepoStatusDto, GitResetMode } from '@sillage/protocol'
import { copyText } from '../../../lib/clipboard'
import { COMMIT_PAGE, useCommitDiff, useCommits } from '../../../lib/commits'
import { relativeDate } from '../../../lib/dates'
import { parseUnifiedDiff } from '../../../lib/diff'
import { useGitAction } from '../../../lib/git'
import { locale, useTranslate } from '../../../lib/i18n'
import { Banner, ChoiceList, ConfirmDialog, IconButton, Menu, MenuItem, MenuSeparator, cx } from '../../ui'
import { FileDiff } from '../diff-parts'
import { failureNotice, useGitPane } from './context'
import { GraphRail } from './GraphRail'
import { graphColor, layoutGitGraph, type GraphRow } from '../../../lib/git-graph'

/**
 * Les commits de la branche, du plus récent au plus ancien, avec les références qui
 * les marquent et ce qu'on peut en faire : créer une branche là, annuler par un commit
 * inverse, ou ramener la branche jusqu'ici.
 *
 * Tous auteurs confondus, donc y compris ce qu'un agent a commité par une commande
 * shell. Ce que l'agent a fait tour par tour est une autre question, et vit dans
 * l'onglet Historique.
 */
export function CommitsSection({ repo }: { repo: GitRepoStatusDto }) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const [all, setAll] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [limit, setLimit] = useState(COMMIT_PAGE)
  const commits = useCommits(scope, limit, all)
  const revert = useGitAction<{ hash: string }, GitActionDto>(scope, 'revert')
  const reset = useGitAction<{ hash: string; mode: GitResetMode }>(scope, 'reset')
  const create = useGitAction<{ name: string; from?: string; checkout: boolean }>(scope, 'branches')
  const [resetting, setResetting] = useState<CommitDto | null>(null)
  const [branching, setBranching] = useState<CommitDto | null>(null)
  const busy = revert.isPending || reset.isPending || create.isPending

  const onError = (error: unknown) => notify(failureNotice(error, t('git.action.failed')))
  const { data, error, isPending, isFetching } = commits

  const graph = useMemo(() => layoutGitGraph(data?.commits ?? []), [data])
  const selectedCommit = data?.commits?.find((commit) => commit.hash === selected)
  const query = search.trim().toLocaleLowerCase()
  const matches = (commit: CommitDto) =>
    !query ||
    [commit.subject, commit.author, commit.hash, ...commit.refs].some((value) =>
      value.toLocaleLowerCase().includes(query),
    )
  const matchCount = data?.commits?.filter(matches).length ?? 0

  return (
    <section className="git-history flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('git.graph.title')}>
      <div className="git-history-toolbar">
        <div className="git-history-title">
          <GitCommitHorizontal size={18} />
          <strong>{t('git.graph.history')}</strong>
          <span>{data?.commits?.length ?? 0}</span>
        </div>
        <div className="git-scope-select">
          <GitBranch size={14} aria-hidden="true" />
          <select
            aria-label={t('git.graph.scope')}
            value={all ? 'all' : 'current'}
            onChange={(event) => {
              setAll(event.target.value === 'all')
              setLimit(COMMIT_PAGE)
              setSelected(null)
            }}
            className="h-8 min-w-0 rounded border border-line bg-surface px-2 text-xs"
          >
            <option value="all">{t('git.graph.all')}</option>
            <option value="current">{t('git.graph.current')}</option>
          </select>
        </div>
        <label className="git-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label={t('git.graph.search')}
            placeholder={t('git.graph.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 min-w-24 flex-1 rounded border border-line bg-sunken px-2 text-xs"
          />
        </label>
        <span className="sr-only" aria-live="polite">
          {t('git.graph.count', { count: query ? matchCount : (data?.commits?.length ?? 0) })}
        </span>
      </div>
      {query ? (
        <p className="border-b border-line px-3 py-2 text-xs text-ink-faint">{t('git.graph.searchHint')}</p>
      ) : null}
      <div className="git-history-body">
        <div className="git-history-list min-h-32 flex-1 overflow-auto" data-git-scroll>
          <div style={{ minWidth: graph.width * 18 + 230 }}>
            {isPending ? (
              <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-ink-faint">
                <Loader size={11} className="animate-spin" />
                {t('changes.commits.loading')}
              </p>
            ) : null}

            {error ? (
              <div className="p-2">
                <Banner>{error instanceof Error ? error.message : t('changes.commits.error')}</Banner>
              </div>
            ) : null}

            {data?.commits?.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-ink-faint">{t('changes.commits.empty')}</p>
            ) : null}

            {(data?.commits ?? []).map((commit, index) => (
              <Commit
                key={commit.hash}
                commit={commit}
                row={graph.rows[index]!}
                graphWidth={graph.width}
                selected={selected === commit.hash}
                muted={!matches(commit)}
                onSelect={() => setSelected((value) => (value === commit.hash ? null : commit.hash))}
                isHead={commit.hash === repo.head?.hash}
                busy={busy}
                onCopy={() => {
                  void copyText(commit.hash)
                  notify({ tone: 'info', text: t('git.commits.copied') })
                }}
                onBranch={() => setBranching(commit)}
                onRevert={() =>
                  revert.mutate(
                    { hash: commit.hash },
                    {
                      onSuccess: (result) =>
                        notify(
                          result.conflicts
                            ? { tone: 'critical', text: t('git.notice.conflicts') }
                            : {
                                tone: 'positive',
                                text: t('git.commits.reverted', { hash: commit.shortHash }),
                              },
                        ),
                      onError,
                    },
                  )
                }
                onReset={() => setResetting(commit)}
              />
            ))}

            {data?.hasMore && limit < 2000 ? (
              <button
                type="button"
                onClick={() => setLimit((value) => Math.min(2000, value + COMMIT_PAGE))}
                disabled={isFetching}
                className="w-full px-2.5 py-2 text-[0.6875rem] text-ink-faint underline hover:text-ink disabled:opacity-45"
              >
                {isFetching ? t('changes.commits.loading') : t('changes.commits.more')}
              </button>
            ) : null}
          </div>
        </div>
        {data?.hasMore && limit >= 2000 ? (
          <p className="p-2 text-xs text-ink-faint">{t('git.graph.limit')}</p>
        ) : null}
        {selectedCommit ? (
          <div className="git-inspector" data-git-inspector>
            <div className="git-inspector-kicker">
              <span>
                <GitCommitHorizontal size={15} />
                {t('git.graph.details')}
              </span>
              <IconButton label={t('git.graph.close')} size="sm" onClick={() => setSelected(null)}>
                <X size={15} />
              </IconButton>
            </div>
            <div className="git-inspector-heading">
              <h3>{selectedCommit.subject}</h3>
              <div className="git-inspector-refs">
                {selectedCommit.refs.map((ref) => (
                  <Ref
                    key={ref}
                    name={ref}
                    color={graphColor(graph.rows[data!.commits!.indexOf(selectedCommit)]!.color)}
                  />
                ))}
              </div>
              <div className="git-author-card">
                <span className="git-avatar">{selectedCommit.author.slice(0, 2).toLocaleUpperCase()}</span>
                <span>
                  <strong>{selectedCommit.author}</strong>
                  <small>{new Date(selectedCommit.ts).toLocaleString(locale())}</small>
                </span>
              </div>
              <button
                type="button"
                className="git-copy-hash"
                onClick={() => {
                  void copyText(selectedCommit.hash)
                  notify({ tone: 'info', text: t('git.commits.copied') })
                }}
                title={t('git.commits.copyHash')}
              >
                <code>{selectedCommit.shortHash}</code>
                <Copy size={12} />
                <span>{t('git.commits.copyHash')}</span>
              </button>
              {selectedCommit.parents.length > 1 ? (
                <p className="git-merge-label">
                  <GitMerge size={13} />
                  {t('git.graph.merge', { count: selectedCommit.parents.length })}
                </p>
              ) : null}
            </div>
            <CommitDiff scope={scope} hash={selectedCommit.hash} />
          </div>
        ) : null}
      </div>
      <div className="git-history-footer">
        <span>
          <GitCommitHorizontal size={13} />
          {t('git.graph.count', { count: data?.commits?.length ?? 0 })}
        </span>
        <span>{selectedCommit ? t('git.graph.keyboard') : t('git.graph.select')}</span>
      </div>
      <ResetDialog
        commit={resetting}
        branch={repo.branch}
        busy={reset.isPending}
        onClose={() => setResetting(null)}
        onConfirm={(mode) =>
          resetting &&
          reset.mutate(
            { hash: resetting.hash, mode },
            { onSuccess: () => notify(null), onError, onSettled: () => setResetting(null) },
          )
        }
      />

      <BranchDialog
        commit={branching}
        busy={create.isPending}
        onClose={() => setBranching(null)}
        onConfirm={(name, checkout) =>
          branching &&
          create.mutate(
            { name, from: branching.hash, checkout },
            {
              onSuccess: () => {
                notify(null)
                setBranching(null)
              },
              onError: (err) => {
                notify(failureNotice(err, t('git.action.failed')))
                setBranching(null)
              },
            },
          )
        }
      />
    </section>
  )
}

function Commit({
  commit,
  row,
  graphWidth,
  selected,
  muted,
  onSelect,
  isHead,
  busy,
  onCopy,
  onBranch,
  onRevert,
  onReset,
}: {
  commit: CommitDto
  row: GraphRow
  graphWidth: number
  selected: boolean
  muted: boolean
  onSelect: () => void
  isHead: boolean
  busy: boolean
  onCopy: () => void
  onBranch: () => void
  onRevert: () => void
  onReset: () => void
}) {
  const t = useTranslate()
  return (
    <div
      className={cx(
        'git-commit-row group/commit flex items-center pr-1',
        selected && 'git-commit-selected',
        muted && 'opacity-30',
      )}
      data-git-commit={commit.hash}
      style={{ borderLeftColor: selected ? graphColor(row.color) : undefined }}
    >
      <GraphRail row={row} width={graphWidth} head={isHead} />
      <button
        type="button"
        onClick={onSelect}
        data-git-select
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          const buttons = Array.from(
            event.currentTarget
              .closest('[data-git-scroll]')!
              .querySelectorAll<HTMLButtonElement>('[data-git-select]'),
          )
          const index = buttons.indexOf(event.currentTarget)
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : index + (event.key === 'ArrowDown' ? 1 : -1)
          const target = buttons[next]
          if (!target) return
          event.preventDefault()
          target.focus()
          if (target.getAttribute('aria-pressed') !== 'true') target.click()
        }}
        aria-pressed={selected}
        className="git-commit-content flex h-full min-w-0 flex-1 flex-col justify-center gap-1 pr-2 text-left focus-visible:outline-2 focus-visible:outline-accent"
        title={commit.subject}
      >
        <span className="git-commit-subject flex w-full min-w-0 items-center gap-1.5">
          {isHead ? (
            <span className="shrink-0 rounded-sm bg-accent-wash px-1 text-[10px] font-semibold text-accent">
              HEAD
            </span>
          ) : null}
          {commit.parents.length > 1 ? <GitMerge size={13} className="shrink-0 text-ink-faint" /> : null}
          <span className="truncate text-[0.8125rem] text-ink">{commit.subject}</span>
        </span>
        <span className="git-commit-meta flex w-full min-w-0 items-center gap-2 overflow-hidden text-ink-faint">
          {commit.refs.map((ref) => (
            <Ref key={ref} name={ref} color={graphColor(row.color)} />
          ))}
          <span className="git-commit-hash shrink-0 font-mono">{commit.shortHash}</span>
          <span className="git-commit-author truncate">{commit.author}</span>
          <span className="ml-auto hidden shrink-0 @min-[30rem]:inline">{relativeDate(commit.ts)}</span>
        </span>
      </button>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/commit:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
        <Menu
          trigger={
            <IconButton
              label={t('git.commits.actions', { hash: commit.shortHash })}
              size="sm"
              disabled={busy}
            >
              <Ellipsis size={15} />
            </IconButton>
          }
        >
          <MenuItem icon={<Copy size={14} />} onSelect={onCopy}>
            {t('git.commits.copyHash')}
          </MenuItem>
          <MenuItem icon={<GitBranchPlus size={14} />} onSelect={onBranch}>
            {t('git.commits.branchHere')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Undo2 size={14} />} onSelect={onRevert}>
            {t('git.commits.revert')}
          </MenuItem>
          <MenuItem icon={<RotateCcw size={14} />} tone="critical" disabled={isHead} onSelect={onReset}>
            {t('git.commits.reset')}
          </MenuItem>
        </Menu>
      </div>
    </div>
  )
}

/** Une référence posée sur un commit : branche locale, branche distante, ou tag. */
function Ref({ name, color }: { name: string; color: string }) {
  const isTag = name.startsWith('tag: ')
  const label = isTag ? name.slice('tag: '.length) : name
  return (
    <span
      className={cx(
        'git-ref inline-flex max-w-40 shrink-0 items-center gap-1 truncate rounded border px-1.5',
        isTag ? 'border-caution/40 text-caution' : 'border-line text-ink-faint',
      )}
      title={label}
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      {isTag ? <Tag size={10} className="shrink-0" /> : <GitBranch size={10} className="shrink-0" />}
      {label}
    </span>
  )
}

function CommitDiff({ scope, hash }: { scope: string; hash: string }) {
  const t = useTranslate()
  const { data, error, isPending } = useCommitDiff(scope, hash, true)
  const files = useMemo(() => (data ? parseUnifiedDiff(data.patch) : []), [data])

  if (isPending) {
    return (
      <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
        <Loader size={11} className="animate-spin" />
        {t('changes.commits.diffLoading')}
      </p>
    )
  }

  if (error) {
    return (
      <p className="px-2.5 py-1.5 text-[0.6875rem] text-critical">
        {error instanceof Error ? error.message : t('changes.commits.error')}
      </p>
    )
  }

  return (
    // Décalé : sans ça, les fichiers d'un commit déplié s'alignent sur les commits
    // eux-mêmes, et la liste se lit comme une seule suite.
    <div className="border-t border-line/60 bg-sunken/40">
      <div className="git-diff-summary">
        <strong>{t('git.graph.files', { count: files.length })}</strong>
        <span className="text-positive">+{data?.files.reduce((sum, file) => sum + file.added, 0) ?? 0}</span>
        <span className="text-critical">
          −{data?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0}
        </span>
      </div>
      {files.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">{t('changes.commits.diffEmpty')}</p>
      ) : null}

      {/* Sans `onOpenFile` : le fichier du disque n'est plus celui de ce commit, et
          ouvrir l'un en croyant lire l'autre est le pire des deux mondes. */}
      {files.map((file) => (
        <FileDiff key={file.path} file={file} />
      ))}

      {data?.truncated ? (
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-caution">{t('changes.diff.truncated')}</p>
      ) : null}
    </div>
  )
}

/**
 * Ramener la branche à un commit, en choisissant ce qu'il advient du travail d'après.
 *
 * Les trois modes sont expliqués en clair : `soft`, `mixed` et `hard` ne disent rien à
 * qui ne les a pas déjà appris à ses dépens, et le dernier détruit du travail.
 */
function ResetDialog({
  commit,
  branch,
  busy,
  onClose,
  onConfirm,
}: {
  commit: CommitDto | null
  branch: string | null
  busy: boolean
  onClose: () => void
  onConfirm: (mode: GitResetMode) => void
}) {
  const t = useTranslate()
  const [mode, setMode] = useState<GitResetMode>('mixed')

  return (
    <ConfirmDialog
      open={commit !== null}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      title={t('git.commits.reset.title', { branch: branch ?? 'HEAD', hash: commit?.shortHash ?? '' })}
      confirmLabel={t('git.commits.reset.confirm')}
      tone={mode === 'hard' ? 'critical' : 'accent'}
      busy={busy}
      onConfirm={() => onConfirm(mode)}
    >
      <p className="truncate font-mono text-xs text-ink-faint">{commit?.subject}</p>
      <ChoiceList
        label={t('git.commits.reset.mode')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'soft', label: t('git.commits.reset.soft'), hint: t('git.commits.reset.softHint') },
          { value: 'mixed', label: t('git.commits.reset.mixed'), hint: t('git.commits.reset.mixedHint') },
          { value: 'hard', label: t('git.commits.reset.hard'), hint: t('git.commits.reset.hardHint') },
        ]}
      />
    </ConfirmDialog>
  )
}

/** Une branche qui part de ce commit, qu'on extrait ou non tout de suite. */
function BranchDialog({
  commit,
  busy,
  onClose,
  onConfirm,
}: {
  commit: CommitDto | null
  busy: boolean
  onClose: () => void
  onConfirm: (name: string, checkout: boolean) => void
}) {
  const t = useTranslate()
  const [name, setName] = useState('')
  const [checkout, setCheckout] = useState(true)

  return (
    <ConfirmDialog
      open={commit !== null}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      title={t('git.commits.branchHere.title', { hash: commit?.shortHash ?? '' })}
      confirmLabel={t('git.branches.create.submit')}
      busy={busy || name.trim().length === 0}
      onConfirm={() => onConfirm(name.trim(), checkout)}
    >
      <p className="truncate font-mono text-xs text-ink-faint">{commit?.subject}</p>
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && name.trim()) {
            event.preventDefault()
            onConfirm(name.trim(), checkout)
          }
        }}
        placeholder={t('worktree.branch.placeholder')}
        aria-label={t('git.branches.create.name')}
        className="h-9 w-full rounded-md border border-line bg-sunken px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
      <label className="flex items-center gap-1.5 text-xs text-ink-soft">
        <input
          type="checkbox"
          checked={checkout}
          onChange={(event) => setCheckout(event.target.checked)}
          className="accent-[var(--sg-accent)]"
        />
        {t('git.branches.create.checkout')}
      </label>
    </ConfirmDialog>
  )
}
