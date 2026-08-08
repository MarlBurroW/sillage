import { ChevronRight, FilePlus2, FileX2, Pencil } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { EditedFile } from '../../lib/chat-fold'
import type { DiffFile } from '../../lib/diff'
import { useTranslate } from '../../lib/i18n'
import { DiffHunks } from '../DiffHunks'
import { cx } from '../ui'

/**
 * Ce que les deux vues de changements ont en commun.
 *
 * L'onglet Git montre ce que dit le dépôt, l'onglet Historique ce que l'agent a écrit
 * dans cette conversation. Deux sources et deux questions, mais les mêmes lignes de
 * fichier et les mêmes couleurs : les partager est le seul moyen qu'elles ne divergent
 * pas d'une vue à l'autre.
 */

/** Icône et teinte par nature de changement. */
export const ACTIONS: Record<EditedFile['action'], { icon: ReactNode; tone: string }> = {
  created: { icon: <FilePlus2 size={12} />, tone: 'text-positive' },
  modified: { icon: <Pencil size={12} />, tone: 'text-caution' },
  deleted: { icon: <FileX2 size={12} />, tone: 'text-critical' },
}

/** Statuts d'un diff ramenés au vocabulaire des trois actions du journal. */
const DIFF_ACTIONS: Record<DiffFile['status'], EditedFile['action']> = {
  added: 'created',
  removed: 'deleted',
  renamed: 'modified',
  modified: 'modified',
  binary: 'modified',
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="surface sticky top-0 z-10 flex items-center gap-2 border-b border-line px-2.5 py-1.5">
      <span className="flex-1 text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
        {children}
      </span>
      {action}
    </div>
  )
}

/** Un fichier d'un diff, dépliable sur ses hunks. */
export function FileDiff({
  file,
  onOpenFile,
}: {
  file: DiffFile
  /** Absent pour un commit passé : le fichier du disque n'est plus celui d'alors. */
  onOpenFile?: (path: string) => void
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

          {onOpenFile && file.status !== 'removed' ? (
            <button
              type="button"
              onClick={() => onOpenFile(file.path)}
              className="px-2.5 py-1.5 text-[0.6875rem] text-ink-faint underline hover:text-ink"
            >
              {t('changes.file.open')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
