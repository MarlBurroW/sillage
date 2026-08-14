import { useQuery } from '@tanstack/react-query'
import { ChevronRight, GitBranch, GitCommitHorizontal, Loader, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommitDto, WorkingDiffDto } from '@sillage/protocol'
import { api } from '../../lib/api'
import { workspaceApiBase } from '../../lib/workspace-scope'
import { COMMIT_PAGE, useCommitDiff, useCommits } from '../../lib/commits'
import { parseUnifiedDiff } from '../../lib/diff'
import { relativeDate } from '../../lib/dates'
import { locale, useTranslate } from '../../lib/i18n'
import { Banner, IconButton, cx } from '../ui'
import { FileDiff, SectionTitle } from './diff-parts'

/**
 * Ce que dit le dépôt : ce qui n'est pas commité, puis les commits.
 *
 * Tous auteurs confondus, donc y compris ce qu'on a modifié soi-même à la main ou ce
 * qu'un agent a écrit par une commande shell. Ce que l'agent a fait tour par tour est
 * une autre question, et vit dans l'onglet Historique : mélanger les deux laissait
 * croire que la seconde liste était l'état du dépôt, alors qu'elle raconte un passé
 * que le disque a pu recouvrir depuis.
 */
export function GitPane({
  scope,
  turnRunning,
  onOpenFile,
}: {
  scope: string
  turnRunning: boolean
  onOpenFile: (path: string) => void
}) {
  const [limit, setLimit] = useState(COMMIT_PAGE)
  const working = useWorkingDiff(scope)
  const commits = useCommits(scope, limit)

  // Un tour qui se termine a pu commiter : les deux listes se relisent ensemble.
  const wasRunning = useRef(turnRunning)
  useEffect(() => {
    if (wasRunning.current && !turnRunning) {
      void working.refetch()
      void commits.refetch()
    }
    wasRunning.current = turnRunning
  }, [turnRunning, working, commits])

  return (
    // `@container` : l'auteur d'un commit ne s'affiche que si la ligne a la place,
    // qui dépend de la largeur du panneau et non de celle de la fenêtre.
    <div className="@container flex h-full min-h-0 min-w-0 flex-col overflow-y-auto pb-safe">
      <WorkingDiff
        query={working}
        onOpenFile={onOpenFile}
        onRefresh={() => {
          void working.refetch()
          void commits.refetch()
        }}
      />
      <Commits
        scope={scope}
        query={commits}
        headHash={working.data?.head?.hash ?? null}
        onMore={() => setLimit((value) => value + COMMIT_PAGE)}
      />
    </div>
  )
}

function useWorkingDiff(scope: string) {
  return useQuery({
    queryKey: ['diff', scope],
    queryFn: () => api.get<WorkingDiffDto>(`${workspaceApiBase(scope)}/diff`),
    // Relu à la fin d'un tour, à chaque ouverture du panneau, et à la demande. Jamais
    // en boucle : un diff se calcule en lançant git, ce n'est pas gratuit.
    //
    // `refetchOnMount` était le manque : un agent qui commite pendant que le panneau
    // est fermé laissait le cache servir un diff périmé au rouvrir, et l'état courant
    // restait celui d'avant le commit.
    staleTime: Infinity,
    refetchOnMount: 'always',
  })
}

function WorkingDiff({
  query,
  onOpenFile,
  onRefresh,
}: {
  query: ReturnType<typeof useWorkingDiff>
  onOpenFile: (path: string) => void
  onRefresh: () => void
}) {
  const t = useTranslate()
  const { data, error, isPending, isFetching } = query
  const files = useMemo(() => (data ? parseUnifiedDiff(data.patch) : []), [data])

  // Sommés depuis le décompte du serveur plutôt que depuis le patch analysé : celui-ci
  // est tronqué au-delà d'une certaine taille, et le total mentirait alors.
  const added = (data?.files ?? []).reduce((sum, file) => sum + file.added, 0)
  const removed = (data?.files ?? []).reduce((sum, file) => sum + file.removed, 0)

  return (
    <section className="shrink-0">
      <SectionTitle
        action={
          <IconButton label={t('changes.diff.recalculate')} size="sm" onClick={onRefresh}>
            <RefreshCw size={13} className={cx(isFetching && 'animate-spin')} />
          </IconButton>
        }
      >
        {t('changes.diff.current')}
      </SectionTitle>

      {data?.branch ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
          <span className="flex items-center gap-1 text-ink-soft">
            <GitBranch size={11} className="shrink-0" />
            {data.branch}
          </span>

          {data.files && data.files.length > 0 ? (
            <span className="flex items-center gap-1.5">
              <span>
                {data.files.length > 1
                  ? t('changes.files.countMany', { count: data.files.length })
                  : t('changes.files.countOne', { count: data.files.length })}
              </span>
              {added > 0 ? <span className="font-mono text-positive">+{added}</span> : null}
              {removed > 0 ? <span className="font-mono text-critical">-{removed}</span> : null}
            </span>
          ) : null}
        </div>
      ) : null}

      {isPending ? (
        <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-ink-faint">
          <Loader size={11} className="animate-spin" />
          {t('changes.diff.loading')}
        </p>
      ) : null}

      {error ? (
        <div className="p-2">
          <Banner>{error instanceof Error ? error.message : t('changes.diff.error')}</Banner>
        </div>
      ) : null}

      {data && data.files === null ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('changes.diff.notGitRepo')}</p>
      ) : null}

      {data?.files?.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('changes.diff.none')}</p>
      ) : null}

      {files.map((file) => (
        <FileDiff key={file.path} file={file} onOpenFile={onOpenFile} />
      ))}

      {data?.truncated ? (
        <p className="px-2.5 py-2 text-[0.6875rem] text-caution">{t('changes.diff.truncated')}</p>
      ) : null}
    </section>
  )
}

function Commits({
  scope,
  query,
  headHash,
  onMore,
}: {
  scope: string
  query: ReturnType<typeof useCommits>
  /** Hash court du commit courant, pour le signaler dans la liste. */
  headHash: string | null
  onMore: () => void
}) {
  const t = useTranslate()
  const { data, error, isPending, isFetching } = query

  return (
    <section className="shrink-0">
      <SectionTitle>{t('changes.commits.title')}</SectionTitle>

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
          scope={scope}
          commit={commit}
          isHead={commit.shortHash === headHash}
        />
      ))}

      {data?.hasMore ? (
        <button
          type="button"
          onClick={onMore}
          disabled={isFetching}
          className="w-full px-2.5 py-2 text-[0.6875rem] text-ink-faint underline hover:text-ink disabled:opacity-45"
        >
          {isFetching ? t('changes.commits.loading') : t('changes.commits.more')}
        </button>
      ) : null}
    </section>
  )
}

function Commit({
  scope,
  commit,
  isHead,
}: {
  scope: string
  commit: CommitDto
  isHead: boolean
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-line/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-surface-high"
        title={new Date(commit.ts).toLocaleString(locale())}
      >
        <ChevronRight
          size={12}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <GitCommitHorizontal size={12} className="shrink-0 text-ink-faint" />
        <span className="shrink-0 font-mono text-[0.625rem] text-ink-faint">
          {commit.shortHash}
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-soft" title={commit.subject}>
          {commit.subject}
        </span>
        {/* Le commit courant se signale : c'est celui contre lequel se lit le diff du
            répertoire de travail juste au-dessus. */}
        {isHead ? (
          <span className="shrink-0 rounded-full bg-accent-wash px-1.5 py-0.5 text-[0.625rem] text-accent">
            {t('changes.commits.head')}
          </span>
        ) : null}
        <span className="hidden shrink-0 text-[0.625rem] text-ink-faint @min-[30rem]:inline">
          {commit.author}
        </span>
        <span className="shrink-0 text-[0.625rem] text-ink-faint">{relativeDate(commit.ts)}</span>
      </button>

      {open ? <CommitDiff scope={scope} hash={commit.hash} /> : null}
    </div>
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
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
          {t('changes.commits.diffEmpty')}
        </p>
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
