import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FilePlus2, FileX2, GitBranch, GitCommitHorizontal, Loader, Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkingDiffDto } from '@sillage/protocol'
import { api } from '../../lib/api'
import type { EditTurn, EditedFile } from '../../lib/chat-fold'
import { useEditDiff } from '../../lib/edits'
import { parseUnifiedDiff, type DiffFile } from '../../lib/diff'
import { languageFromPath } from '../../lib/highlight'
import { locale, useTranslate } from '../../lib/i18n'
import { DiffHunks } from '../DiffHunks'
import { HighlightedCode } from '../chat/HighlightedCode'
import { Banner, IconButton, cx } from '../ui'

/** Icône et teinte par nature de changement, partagées par les deux sections. */
const ACTIONS: Record<EditedFile['action'], { icon: ReactNode; tone: string }> = {
  created: { icon: <FilePlus2 size={12} />, tone: 'text-positive' },
  modified: { icon: <Pencil size={12} />, tone: 'text-caution' },
  deleted: { icon: <FileX2 size={12} />, tone: 'text-critical' },
}

/** Heure seule : l'historique ne couvre qu'une conversation, jamais plusieurs jours d'affilée. */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

/**
 * Deux sections qui répondent à deux questions différentes.
 *
 * En haut, où en est le dépôt : le diff du répertoire de travail contre HEAD, tous
 * auteurs confondus, donc y compris ce qu'on a soi-même modifié à la main ou ce qu'un
 * agent a écrit par une commande shell. En bas, ce que l'agent a fait dans cette
 * conversation, tour par tour, dérivé du journal.
 */
export function ChangesPane({
  conversationId,
  editTurns,
  turnRunning,
  onOpenFile,
}: {
  conversationId: string
  editTurns: EditTurn[]
  turnRunning: boolean
  /** Bascule sur l'éditeur : ouvrir un onglet sans le montrer paraît sans effet. */
  onOpenFile: (path: string) => void
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto pb-safe">
      <WorkingDiff
        conversationId={conversationId}
        turnRunning={turnRunning}
        onOpenFile={onOpenFile}
      />
      <History conversationId={conversationId} turns={editTurns} onOpenFile={onOpenFile} />
    </div>
  )
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="surface sticky top-0 z-10 flex items-center gap-2 border-b border-line px-2.5 py-1.5">
      <span className="flex-1 text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
        {children}
      </span>
      {action}
    </div>
  )
}

function WorkingDiff({
  conversationId,
  turnRunning,
  onOpenFile,
}: {
  conversationId: string
  turnRunning: boolean
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['diff', conversationId],
    queryFn: () => api.get<WorkingDiffDto>(`/api/conversations/${conversationId}/diff`),
    // Relu à la fin d'un tour, à chaque ouverture du panneau, et à la demande. Jamais
    // en boucle : un diff se calcule en lançant git, ce n'est pas gratuit.
    //
    // `refetchOnMount` était le manque : un agent qui commite pendant que le panneau
    // est fermé laissait le cache servir un diff périmé au rouvrir, et l'état courant
    // restait celui d'avant le commit.
    staleTime: Infinity,
    refetchOnMount: 'always',
  })

  const wasRunning = useRef(turnRunning)
  useEffect(() => {
    if (wasRunning.current && !turnRunning) void refetch()
    wasRunning.current = turnRunning
  }, [turnRunning, refetch])

  const files = useMemo(() => (data ? parseUnifiedDiff(data.patch) : []), [data])

  // Sommés depuis le décompte du serveur plutôt que depuis le patch analysé : celui-ci
  // est tronqué au-delà d'une certaine taille, et le total mentirait alors.
  const added = (data?.files ?? []).reduce((sum, file) => sum + file.added, 0)
  const removed = (data?.files ?? []).reduce((sum, file) => sum + file.removed, 0)

  return (
    <section className="shrink-0">
      <SectionTitle
        action={
          <IconButton label={t('changes.diff.recalculate')} size="sm" onClick={() => void refetch()}>
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

          {/* Le dernier commit distingue les deux causes d'un diff vide : rien n'a
              bougé, ou l'agent vient de commiter ce qu'il a fait. */}
          {data.head ? (
            <span
              className="flex min-w-0 items-center gap-1"
              title={`${data.head.hash} · ${data.head.subject}`}
            >
              <GitCommitHorizontal size={11} className="shrink-0" />
              <span className="font-mono">{data.head.hash}</span>
              <span className="min-w-0 truncate">{data.head.subject}</span>
              <span className="shrink-0">· {data.head.relativeDate}</span>
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

/** Statuts du diff ramenés au vocabulaire des trois actions du journal. */
const DIFF_ACTIONS: Record<DiffFile['status'], EditedFile['action']> = {
  added: 'created',
  removed: 'deleted',
  renamed: 'modified',
  modified: 'modified',
  binary: 'modified',
}

function FileDiff({
  file,
  onOpenFile,
}: {
  file: DiffFile
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const action = ACTIONS[DIFF_ACTIONS[file.status]]

  return (
    <div className="border-b border-line/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-surface-high"
      >
        <ChevronRight
          size={12}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <span className={cx('shrink-0', action.tone)}>{action.icon}</span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-soft" title={file.path}>
          {file.path}
        </span>
        {file.added > 0 ? (
          <span className="shrink-0 font-mono text-[0.625rem] text-positive">+{file.added}</span>
        ) : null}
        {file.removed > 0 ? (
          <span className="shrink-0 font-mono text-[0.625rem] text-critical">-{file.removed}</span>
        ) : null}
      </button>

      {open ? (
        <div className="border-t border-line/60">
          {file.status === 'binary' ? (
            <p className="px-2.5 py-2 text-xs text-ink-faint">{t('changes.file.binary')}</p>
          ) : (
            <DiffHunks hunks={file.hunks} path={file.path} />
          )}

          {file.status === 'removed' ? null : (
            <button
              type="button"
              onClick={() => onOpenFile(file.path)}
              className="px-2.5 py-1.5 text-[0.6875rem] text-ink-faint underline hover:text-ink"
            >
              {t('changes.file.open')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}

function History({
  conversationId,
  turns,
  onOpenFile,
}: {
  conversationId: string
  turns: EditTurn[]
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()

  return (
    <section className="shrink-0">
      <SectionTitle>{t('changes.history.title')}</SectionTitle>

      {turns.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('changes.history.empty')}</p>
      ) : null}

      {/* Le plus récent en tête : c'est le tour dont on vient de voir le résultat. */}
      {[...turns].reverse().map((turn) => (
        <HistoryTurn
          key={turn.id}
          conversationId={conversationId}
          turn={turn}
          onOpenFile={onOpenFile}
        />
      ))}
    </section>
  )
}

function HistoryTurn({
  conversationId,
  turn,
  onOpenFile,
}: {
  conversationId: string
  turn: EditTurn
  onOpenFile: (path: string) => void
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
      >
        <ChevronRight
          size={12}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <span className="shrink-0 font-mono text-[0.625rem] text-ink-faint">
          {formatTime(turn.ts)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-soft" title={turn.label}>
          {turn.label}
        </span>
        <span className="shrink-0 text-[0.625rem] text-ink-faint">
          {turn.files.length > 1
            ? t('changes.files.countMany', { count: turn.files.length })
            : t('changes.files.countOne', { count: turn.files.length })}
        </span>
      </button>

      {open ? (
        <ul className="border-t border-line/60 py-0.5">
          {turn.files.map((file) => (
            <li key={file.path}>
              <HistoryFile
                conversationId={conversationId}
                file={file}
                onOpenFile={onOpenFile}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Un fichier touché pendant un tour passé, dépliable sur ses modifications.
 *
 * Le diff ne peut pas venir de git : le disque a continué d'évoluer depuis. Il est
 * reconstitué depuis le payload natif de chaque appel, ce qui limite ce qu'on peut en
 * dire (voir `EditDiffDto`), mais reste la seule source fidèle à ce moment-là.
 */
function HistoryFile({
  conversationId,
  file,
  onOpenFile,
}: {
  conversationId: string
  file: EditedFile
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 pr-2 pl-5 text-left hover:bg-surface-high"
      >
        <ChevronRight
          size={11}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <span className={cx('shrink-0', ACTIONS[file.action].tone)}>
          {ACTIONS[file.action].icon}
        </span>
        <span
          className={cx(
            'min-w-0 flex-1 truncate text-[0.75rem]',
            file.action === 'deleted' ? 'text-ink-faint line-through' : 'text-ink-soft',
          )}
          title={file.path}
        >
          {file.path}
        </span>
        {/* Le décompte n'apparaît que s'il y a plusieurs passes : afficher « 1 » sur
            chaque ligne n'apprendrait rien. */}
        {file.toolCallIds.length > 1 ? (
          <span className="shrink-0 text-[0.625rem] text-ink-faint">
            {t('changes.file.passes', { count: file.toolCallIds.length })}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="border-y border-line/60 bg-sunken/40">
          {file.toolCallIds.map((toolCallId, index) => (
            <EditDiff
              key={toolCallId}
              conversationId={conversationId}
              toolCallId={toolCallId}
              path={file.path}
              rank={file.toolCallIds.length > 1 ? index + 1 : null}
            />
          ))}

          {/* Un fichier supprimé n'a plus rien à ouvrir : l'action disparaît plutôt
              que d'ouvrir un onglet en erreur. */}
          {file.action === 'deleted' ? null : (
            <button
              type="button"
              onClick={() => onOpenFile(file.path)}
              className="px-2.5 py-1.5 text-[0.6875rem] text-ink-faint underline hover:text-ink"
            >
              {t('changes.file.open')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Une modification, telle que le payload de son appel permet de la reconstituer. */
function EditDiff({
  conversationId,
  toolCallId,
  path,
  rank,
}: {
  conversationId: string
  toolCallId: string
  path: string
  /** Rang de la passe, quand le fichier a été repris plusieurs fois dans le tour. */
  rank: number | null
}) {
  const t = useTranslate()
  const { data, error, isPending } = useEditDiff(conversationId, toolCallId, path)
  const files = useMemo(
    () => (data?.kind === 'patch' ? parseUnifiedDiff(data.patch) : []),
    [data],
  )

  if (isPending) {
    return (
      <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
        <Loader size={11} className="animate-spin" />
        {t('changes.edit.loading')}
      </p>
    )
  }

  if (error || !data) {
    return (
      <p className="px-2.5 py-1.5 text-[0.6875rem] text-critical">
        {error instanceof Error ? error.message : t('changes.edit.error')}
      </p>
    )
  }

  return (
    <div>
      {rank === null && !data.partial && data.kind === 'patch' ? null : (
        <p className="px-2.5 pt-1.5 text-[0.625rem] text-ink-faint">
          {[
            rank === null ? null : t('changes.edit.pass', { rank }),
            data.partial ? t('changes.edit.partial') : null,
            data.reason,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      {files.map((entry) => (
        <DiffHunks key={entry.path} hunks={entry.hunks} path={path} />
      ))}

      {/* Un contenu écrit reste du code : il se colore comme le reste, même sans
          diff auquel le comparer. */}
      {data.kind === 'content' ? (
        <HighlightedCode
          code={data.content}
          language={languageFromPath(path)}
          className="px-2.5 py-1.5 font-mono text-[0.6875rem] text-ink-soft"
        />
      ) : null}
    </div>
  )
}
