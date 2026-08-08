import { ChevronRight, Loader } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { EditTurn, EditedFile } from '../../lib/chat-fold'
import { parseUnifiedDiff } from '../../lib/diff'
import { useEditDiff } from '../../lib/edits'
import { languageFromPath } from '../../lib/highlight'
import { locale, useTranslate } from '../../lib/i18n'
import { DiffHunks } from '../DiffHunks'
import { HighlightedCode } from '../chat/HighlightedCode'
import { cx } from '../ui'
import { ACTIONS, SectionTitle } from './diff-parts'

/** Heure seule : l'historique ne couvre qu'une conversation, jamais plusieurs jours d'affilée. */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

/**
 * Ce que l'agent a écrit dans cette conversation, tour par tour.
 *
 * Dérivé du journal, et non du dépôt : c'est un passé, pas un état. Le disque a pu
 * changer depuis, l'agent peut avoir commité, et rien de ce qui est listé ici n'est
 * forcément encore vrai. L'onglet Git répond à l'autre question.
 */
export function HistoryPane({
  conversationId,
  turns,
  onOpenFile,
}: {
  conversationId: string
  turns: EditTurn[]
  /** Bascule sur les fichiers : ouvrir un onglet sans le montrer paraît sans effet. */
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto pb-safe">
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
    </div>
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
    <div className="shrink-0 border-b border-line/60">
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
              <HistoryFile conversationId={conversationId} file={file} onOpenFile={onOpenFile} />
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
  const files = useMemo(() => (data?.kind === 'patch' ? parseUnifiedDiff(data.patch) : []), [data])

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
