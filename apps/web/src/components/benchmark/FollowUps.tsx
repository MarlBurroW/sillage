import { MessageSquareReply } from 'lucide-react'
import { useState } from 'react'
import { MAX_BENCHMARK_PROMPT_CHARS, canFollowUp, type BenchmarkDto, type BenchmarkFollowUp, type BenchmarkRunDto } from '@sillage/protocol'
import { RUN_STATUS_LABELS, RUN_TONES, useFollowUpBenchmarkRuns } from '../../lib/benchmarks'
import { locale, useTranslate } from '../../lib/i18n'
import { Banner, ConfirmDialog, Popover, cx } from '../ui'

/** Follow-ups of one run, or of every run of a variant on its median line, each with its run. */
export interface FollowUpEntry {
  followUp: BenchmarkFollowUp
  /** Repetition the follow-up went to, shown when several runs are listed together. */
  repetition: number | null
}

export function followUpEntries(runs: BenchmarkRunDto[]): FollowUpEntry[] {
  const several = runs.length > 1
  return runs.flatMap((run) => run.followUps.map((followUp) => ({ followUp, repetition: several ? run.repetition : null })))
}

/**
 * Says that a result needed a human correction, and opens on what was written. A button rather
 * than a tooltip: the texts must be readable on a phone too, and a correction can run long.
 */
export function FollowUpBadge({ entries, className }: { entries: FollowUpEntry[]; className?: string }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return null
  const count = t(entries.length === 1 ? 'benchmark.followUp.count.one' : 'benchmark.followUp.count', { count: entries.length })
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('benchmark.followUp.list')}
      align="start"
      side="bottom"
      className="w-[min(26rem,calc(100vw-1.5rem))]"
      trigger={(
        <button
          type="button"
          className={cx('inline-flex items-center gap-1 rounded-sm bg-caution/12 px-1.5 text-[0.6875rem] leading-5 font-medium whitespace-nowrap text-caution hover:bg-caution/20', className)}
          title={t('benchmark.followUp.badgeHint')}
          data-follow-up-badge={entries.length}
        >
          <MessageSquareReply size={11} aria-hidden />
          {count}
        </button>
      )}
    >
      <div className="border-b border-line px-3 py-2">
        <p className="text-sm font-semibold text-ink">{count}</p>
        <p className="text-xs text-ink-faint">{t('benchmark.followUp.listHint')}</p>
      </div>
      <ol className="flex min-h-0 flex-col divide-y divide-line overflow-y-auto">
        {entries.map((entry, index) => (
          <li key={`${entry.followUp.sentAt}-${index}`} className="px-3 py-2">
            <p className="text-[0.6875rem] text-ink-faint">
              {[
                entry.repetition !== null ? t('benchmark.table.repetition', { n: entry.repetition }) : null,
                new Date(entry.followUp.sentAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }),
              ].filter(Boolean).join(' · ')}
            </p>
            <p className="mt-0.5 text-sm whitespace-pre-wrap text-ink">{entry.followUp.text}</p>
          </li>
        ))}
      </ol>
    </Popover>
  )
}

/**
 * Writes one correction for finished runs. It continues each run's own session rather than
 * starting another: the run reopens, its measurements add the correction's work to the first
 * attempt's, and the check runs again. The run it was opened from comes ticked; any other
 * finished run can join, for a correction several models need.
 */
export function FollowUpDialog({ benchmark, initial, nameOf, onClose }: {
  benchmark: BenchmarkDto
  initial: string[]
  nameOf: (variantId: string) => { label: string; text: string }
  onClose: () => void
}) {
  const t = useTranslate()
  const followUp = useFollowUpBenchmarkRuns(benchmark.id)
  const order = new Map(benchmark.variants.map((variant, index) => [variant.id, index]))
  const candidates = benchmark.runs
    .filter(canFollowUp)
    .sort((a, b) => (order.get(a.variantId) ?? 0) - (order.get(b.variantId) ?? 0) || a.repetition - b.repetition)
  const [picked, setPicked] = useState<string[]>(() => initial.filter((id) => candidates.some((run) => run.id === id)))
  const [text, setText] = useState('')
  const several = benchmark.repetitions > 1
  const rated = candidates.some((run) => picked.includes(run.id) && run.rating !== null)

  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
  // In lineup order, whatever order they were ticked in: the messages leave in that order.
  const send = () => followUp.mutate({ runIds: candidates.filter((run) => picked.includes(run.id)).map((run) => run.id), text: text.trim() }, { onSuccess: onClose })

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      size="wide"
      title={t('benchmark.followUp.title')}
      confirmLabel={t(picked.length > 1 ? 'benchmark.followUp.send.many' : 'benchmark.followUp.send', { count: picked.length })}
      busy={followUp.isPending}
      confirmDisabled={picked.length === 0 || !text.trim()}
      onConfirm={send}
    >
      <div className="flex flex-col gap-4" data-follow-up-dialog>
        <p className="text-sm text-ink-soft">{t('benchmark.followUp.description')}</p>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-soft">{t('benchmark.followUp.text')}</span>
          <textarea
            rows={5}
            autoFocus
            maxLength={MAX_BENCHMARK_PROMPT_CHARS}
            value={text}
            placeholder={t('benchmark.followUp.placeholder')}
            onChange={(event) => setText(event.target.value)}
            className="rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
            data-follow-up-text
          />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink-soft">{t('benchmark.followUp.runs')}</legend>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {candidates.map((run) => (
              <li key={run.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                  <input type="checkbox" checked={picked.includes(run.id)} onChange={() => toggle(run.id)} className="size-4 shrink-0 accent-[var(--sg-accent)]" data-follow-up-run={run.id} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {nameOf(run.variantId).label}
                    {several ? <span className="text-ink-faint"> · {t('benchmark.table.repetition', { n: run.repetition })}</span> : null}
                  </span>
                  {run.followUps.length > 0 ? (
                    <span className="shrink-0 text-[0.6875rem] text-caution">
                      {t(run.followUps.length === 1 ? 'benchmark.followUp.count.one' : 'benchmark.followUp.count', { count: run.followUps.length })}
                    </span>
                  ) : null}
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-ink-soft">
                    <span aria-hidden className={cx('size-1.5 rounded-full', RUN_TONES[run.status])} />
                    {run.check && !run.check.passed ? t('benchmark.followUp.checkFailed') : t(RUN_STATUS_LABELS[run.status])}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <p className="text-xs text-ink-faint">{t('benchmark.followUp.measures')}</p>
        {rated ? <p className="text-xs text-caution">{t('benchmark.followUp.rating')}</p> : null}
        {followUp.error ? <Banner>{followUp.error.message}</Banner> : null}
      </div>
    </ConfirmDialog>
  )
}
