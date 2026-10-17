import { GitCompare, Undo2 } from 'lucide-react'
import type { TurnCheckpoint } from '../../lib/chat-fold'
import { hasChanges, sumLines } from '../../lib/checkpoints'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Ce qu'un tour a changé dans le dépôt, en une ligne sous le tour.
 *
 * Un repère et non une bulle : il ne dit rien que le tour n'ait déjà dit, il ouvre
 * seulement sur le diff et sur le retour en arrière. Un tour sans changement n'en a
 * pas, et une capture manquée non plus : le fil n'a pas à annoncer ce qu'il ne peut
 * pas montrer.
 */
export function TurnChanges({
  checkpoint,
  onShow,
  onRestore,
}: {
  checkpoint: TurnCheckpoint
  onShow: (checkpoint: TurnCheckpoint) => void
  /** Absent quand le lecteur ne peut pas toucher au dépôt : conversation partagée. */
  onRestore?: (checkpoint: TurnCheckpoint) => void
}) {
  const t = useTranslate()
  if (!hasChanges(checkpoint)) return null
  const { added, removed } = sumLines(checkpoint)
  const count = checkpoint.files.length

  return (
    <div
      data-checkpoint={checkpoint.key}
      className={cx(
        // Bordure gauche à angles droits : un repère de marge, pas une carte.
        'my-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 py-1 pl-3 text-[0.75rem] text-ink-faint',
        checkpoint.restored ? 'border-ink-faint/40' : 'border-accent/50',
      )}
    >
      <button
        type="button"
        onClick={() => onShow(checkpoint)}
        className="flex min-w-0 items-center gap-1.5 text-left text-ink-soft hover:text-ink"
        title={t('checkpoint.show.title')}
      >
        <GitCompare size={13} className="shrink-0" />
        <span>
          {count > 1
            ? t('checkpoint.summary.many', { count })
            : t('checkpoint.summary.one', { count })}
        </span>
        {added > 0 ? <span className="font-mono text-[0.6875rem] text-positive">+{added}</span> : null}
        {removed > 0 ? <span className="font-mono text-[0.6875rem] text-critical">-{removed}</span> : null}
        {checkpoint.truncated ? <span>{t('checkpoint.summary.truncated')}</span> : null}
      </button>
      {checkpoint.restored ? (
        <span className="italic">{t('checkpoint.restored.badge')}</span>
      ) : null}
      {onRestore ? (
        <button
          type="button"
          onClick={() => onRestore(checkpoint)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface-high hover:text-ink"
          title={t('checkpoint.restore.title')}
        >
          <Undo2 size={12} />
          {t('checkpoint.restore.action')}
        </button>
      ) : null}
    </div>
  )
}
