import { MessageSquareQuote, Star } from 'lucide-react'
import { useState } from 'react'
import { MAX_BENCHMARK_RATING, type BenchmarkRunDto } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { Popover, cx } from '../ui'

/**
 * What the author thought of a variant's runs, opened from a small mark beside its status. A
 * button with a panel rather than a tooltip, so a comment reads on a phone too. The mark counts
 * comments only when several runs carry one.
 */
export function CommentBadge({ runs, className }: { runs: BenchmarkRunDto[]; className?: string }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const several = runs.length > 1
  const entries = runs.filter((run) => run.ratingNote)
  if (entries.length === 0) return null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('benchmark.comment.list')}
      align="start"
      side="bottom"
      className="w-[min(26rem,calc(100vw-1.5rem))]"
      trigger={(
        <button
          type="button"
          className={cx('inline-flex items-center gap-1 rounded-sm bg-accent/10 px-1.5 text-[0.6875rem] leading-5 font-medium whitespace-nowrap text-accent hover:bg-accent/20', className)}
          aria-label={t('benchmark.comment.open')}
          title={t('benchmark.comment.open')}
          data-comment-badge={entries.length}
        >
          <MessageSquareQuote size={11} aria-hidden />
          {entries.length > 1 ? entries.length : null}
        </button>
      )}
    >
      <p className="border-b border-line px-3 py-2 text-sm font-semibold text-ink">{t('benchmark.comment.list')}</p>
      <ul className="flex min-h-0 flex-col divide-y divide-line overflow-y-auto">
        {entries.map((run) => (
          <li key={run.id} className="px-3 py-2">
            {several || run.rating !== null ? (
              <p className="flex items-center gap-2 text-[0.6875rem] text-ink-faint">
                {several ? <span>{t('benchmark.table.repetition', { n: run.repetition })}</span> : null}
                {run.rating !== null ? (
                  <span className="inline-flex items-center gap-0.5" aria-label={t('benchmark.rating.value', { value: run.rating, max: MAX_BENCHMARK_RATING })}>
                    {Array.from({ length: MAX_BENCHMARK_RATING }, (_, index) => (
                      <Star key={index} size={11} aria-hidden className={cx(index < run.rating! ? 'fill-accent text-accent' : 'text-ink-faint')} />
                    ))}
                  </span>
                ) : null}
              </p>
            ) : null}
            <p className="mt-0.5 text-sm whitespace-pre-wrap text-ink">{run.ratingNote}</p>
          </li>
        ))}
      </ul>
    </Popover>
  )
}
