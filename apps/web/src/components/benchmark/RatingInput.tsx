import { Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MAX_BENCHMARK_RATING, MAX_BENCHMARK_RATING_NOTE_CHARS, type BenchmarkRunDto } from '@sillage/protocol'
import { useRateBenchmarkRun } from '../../lib/benchmarks'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Rating of one run, from 1 to 5, with an optional note. A radio group of stars: arrows move the
 * choice, the current star clicked again clears it. The note saves when the field loses focus so
 * typing never waits on the network.
 */
export function RatingInput({ benchmarkId, run, label }: { benchmarkId: string; run: BenchmarkRunDto; label: string }) {
  const t = useTranslate()
  const rate = useRateBenchmarkRun(benchmarkId)
  const [note, setNote] = useState(run.ratingNote ?? '')
  // Another device may rate the same run: follow the server when the field is not being edited.
  useEffect(() => setNote(run.ratingNote ?? ''), [run.ratingNote])
  const current = run.rating ?? 0
  const save = (rating: number | null, text = note) => rate.mutate({ runId: run.id, rating, note: text.trim() || null })
  const values = Array.from({ length: MAX_BENCHMARK_RATING }, (_, index) => index + 1)

  return (
    <div className="flex flex-col gap-2" data-benchmark-rating={run.rating ?? 'none'}>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex items-center gap-0.5"
        onKeyDown={(event) => {
          const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0
          if (!step) return
          event.preventDefault()
          const next = Math.min(MAX_BENCHMARK_RATING, Math.max(1, current + step))
          save(next)
          ;(event.currentTarget.querySelector(`[data-star="${next}"]`) as HTMLElement | null)?.focus()
        }}
      >
        {values.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            data-star={value}
            aria-checked={current === value}
            aria-label={t('benchmark.rating.value', { value, max: MAX_BENCHMARK_RATING })}
            tabIndex={current === value || (current === 0 && value === 1) ? 0 : -1}
            onClick={() => save(current === value ? null : value)}
            className="flex size-11 items-center justify-center rounded-md text-ink-faint transition-colors hover:text-accent md:size-8 pointer-coarse:size-11"
          >
            <Star size={18} className={cx(value <= current && 'fill-accent text-accent')} />
          </button>
        ))}
        {rate.isError ? <span className="ml-2 text-xs text-critical">{rate.error.message}</span> : null}
      </div>
      {run.rating !== null ? (
        <textarea
          rows={2}
          maxLength={MAX_BENCHMARK_RATING_NOTE_CHARS}
          value={note}
          aria-label={t('benchmark.rating.note')}
          placeholder={t('benchmark.rating.notePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => { if ((run.ratingNote ?? '') !== note.trim()) save(run.rating, note) }}
          className="rounded-md border border-line bg-sunken px-2 py-1.5 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
        />
      ) : null}
    </div>
  )
}
