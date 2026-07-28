import { ChevronRight, Waves } from 'lucide-react'
import { useState } from 'react'
import type { TaskItem } from '../../lib/chat-fold'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'
import { Markdown } from './Markdown'
import { formatDuration } from './ToolCall'

/**
 * Le compte rendu d'un travail qui s'est terminé hors du tour.
 *
 * Replié par défaut : il arrive dans le fil longtemps après ce qui l'a lancé, souvent
 * pendant qu'on lit autre chose, et un rapport de mille mots qui se déplie tout seul
 * pousse la conversation hors de l'écran. La ligne dit ce qui a fini, le contenu
 * attend qu'on le demande.
 */
export function TaskResult({ item }: { item: TaskItem }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-md border border-line bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs"
      >
        <ChevronRight
          size={14}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <Waves size={13} className={cx('shrink-0', item.status === 'failed' ? 'text-critical' : 'text-ink-faint')} />

        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{item.description}</span>
          <span className="block truncate text-[0.6875rem] text-ink-faint">
            {t(STATUS_KEYS[item.status])}
          </span>
        </span>

        {item.durationMs !== null ? (
          <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
            {formatDuration(item.durationMs)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="border-t border-line px-3 py-2">
          <Markdown text={item.summary} />
        </div>
      ) : null}
    </div>
  )
}

const STATUS_KEYS = {
  completed: 'task.status.completed',
  failed: 'task.status.failed',
  stopped: 'task.status.stopped',
} as const
