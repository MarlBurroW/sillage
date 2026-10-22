import { GitCompare, Undo2 } from 'lucide-react'
import type { TurnCheckpoint } from '../../lib/chat-fold'
import { hasChanges, sumLines } from '../../lib/checkpoints'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Single-line turn changes beneath the turn. A marker rather than a bubble, linking to
 * diff/restoration without adding narrative. Omit unchanged turns and failed snapshots because the
 * thread should not advertise unavailable content.
 */
export function TurnChanges({
  checkpoint,
  onShow,
  onRestore,
}: {
  checkpoint: TurnCheckpoint
  onShow: (checkpoint: TurnCheckpoint) => void
  /** Absent for readers unable to modify repositories, such as shared conversations. */
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
        // Sharp-cornered left border: margin marker rather than card.
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
