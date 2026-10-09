import {
  ChevronRight,
  Copy,
  Ellipsis,
  GitBranchPlus,
  GitCommitHorizontal,
  Loader,
  RotateCcw,
  Tag,
  Undo2,
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
import { Section, useSectionOpen } from './Section'

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
  const [open, toggle] = useSectionOpen('commits', true)
  const [limit, setLimit] = useState(COMMIT_PAGE)
  const commits = useCommits(scope, limit)
  const revert = useGitAction<{ hash: string }, GitActionDto>(scope, 'revert')
  const reset = useGitAction<{ hash: string; mode: GitResetMode }>(scope, 'reset')
  const create = useGitAction<{ name: string; from?: string; checkout: boolean }>(scope, 'branches')
  const [resetting, setResetting] = useState<CommitDto | null>(null)
  const [branching, setBranching] = useState<CommitDto | null>(null)
  const busy = revert.isPending || reset.isPending || create.isPending

  const onError = (error: unknown) => notify(failureNotice(error, t('git.action.failed')))
  const { data, error, isPending, isFetching } = commits

  return (
    <Section title={t('changes.commits.title')} open={open} onToggle={toggle}>
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

      {(data?.commits ?? []).map((commit) => (
        <Commit
          key={commit.hash}
          commit={commit}
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
                      : { tone: 'positive', text: t('git.commits.reverted', { hash: commit.shortHash }) },
                  ),
                onError,
              },
            )
          }
          onReset={() => setResetting(commit)}
        />
      ))}

      {data?.hasMore ? (
        <button
          type="button"
          onClick={() => setLimit((value) => value + COMMIT_PAGE)}
          disabled={isFetching}
          className="w-full px-2.5 py-2 text-[0.6875rem] text-ink-faint underline hover:text-ink disabled:opacity-45"
        >
          {isFetching ? t('changes.commits.loading') : t('changes.commits.more')}
        </button>
      ) : null}

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
    </Section>
  )
}

function Commit({
  commit,
  isHead,
  busy,
  onCopy,
  onBranch,
  onRevert,
  onReset,
}: {
  commit: CommitDto
  isHead: boolean
  busy: boolean
  onCopy: () => void
  onBranch: () => void
  onRevert: () => void
  onReset: () => void
}) {
  const t = useTranslate()
  const { scope } = useGitPane()
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-line/60">
      <div className="group/commit flex items-center gap-0.5 pr-1 hover:bg-surface-high">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          // Sur un panneau étroit, le sujet garde la ligne entière et le reste passe
          // dessous : les références et la date mangeaient sinon tout le sujet.
          className="flex min-h-8 w-full min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 py-1 pl-2 text-left @min-[30rem]:flex-nowrap"
          title={new Date(commit.ts).toLocaleString(locale())}
        >
          <ChevronRight
            size={12}
            className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
          />
          <GitCommitHorizontal size={12} className={cx('shrink-0', isHead ? 'text-accent' : 'text-ink-faint')} />
          <span className="shrink-0 font-mono text-[0.625rem] text-ink-faint">{commit.shortHash}</span>
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-soft" title={commit.subject}>
            {commit.subject}
          </span>
          <span className="flex min-w-0 shrink-0 items-center gap-1.5 @max-[30rem]:basis-full @max-[30rem]:pl-10">
            {/* Les références disent où en sont les branches par rapport à l'historique :
                c'est la lecture qu'on fait d'un graphe, sans le graphe. */}
            {commit.refs.map((ref) => (
              <Ref key={ref} name={ref} />
            ))}
            {isHead ? (
              <span className="shrink-0 rounded-full bg-accent-wash px-1.5 py-0.5 text-[0.625rem] text-accent">
                {t('changes.commits.head')}
              </span>
            ) : null}
            <span className="hidden shrink-0 text-[0.625rem] text-ink-faint @min-[30rem]:inline">
              {commit.author}
            </span>
            <span className="shrink-0 text-[0.625rem] text-ink-faint">{relativeDate(commit.ts)}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/commit:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
          <Menu
            trigger={
              <IconButton label={t('git.commits.actions', { hash: commit.shortHash })} size="sm" disabled={busy}>
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

      {open ? <CommitDiff scope={scope} hash={commit.hash} /> : null}
    </div>
  )
}

/** Une référence posée sur un commit : branche locale, branche distante, ou tag. */
function Ref({ name }: { name: string }) {
  const isTag = name.startsWith('tag: ')
  const label = isTag ? name.slice('tag: '.length) : name
  return (
    <span
      className={cx(
        'inline-flex max-w-32 shrink-0 items-center gap-0.5 truncate rounded-sm border px-1 font-mono text-[0.625rem]',
        isTag ? 'border-caution/40 text-caution' : 'border-line text-ink-faint',
      )}
      title={label}
    >
      {isTag ? <Tag size={9} className="shrink-0" /> : null}
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
    <div className="border-t border-line/60 bg-sunken/40 pl-4">
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
