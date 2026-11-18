import { Plus, Swords, X } from 'lucide-react'
import { useState } from 'react'
import { MAX_BENCHMARK_COMPARISONS, MAX_BENCHMARK_COMPARISON_TITLE_CHARS, MAX_BENCHMARK_COMPARISON_VARIANTS } from '@sillage/protocol'
import { rowTitle, rowsEffortsDiffer, useLineupFacts, type LineupComparison, type LineupRow } from '../../lib/benchmark-lineup'
import { useAgentAvailability } from '../../lib/agents'
import { useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Button, ConfirmDialog, Field, IconButton, cx } from '../ui'

/**
 * Comparisons to keep with the benchmark (two models of the same range from two vendors, say):
 * presets carry them, the benchmark page and its shared page feature them, and each becomes a
 * slide. Created here by picking rows; they follow the rows as they move.
 */
export function ComparisonsField({ rows, comparisons, onChange }: {
  rows: LineupRow[]
  comparisons: LineupComparison[]
  onChange: (comparisons: LineupComparison[]) => void
}) {
  const t = useTranslate()
  const { data: availability } = useAgentAvailability()
  const installed = (agent: string) => availability?.agents.some((entry) => entry.agent === agent && entry.installed) === true
  const facts = useLineupFacts(rows, installed)
  const effortsDiffer = rowsEffortsDiffer(rows, facts)
  const titleOf = (key: string) => {
    const row = rows.find((entry) => entry.key === key)
    return row ? rowTitle(row, facts.get(key), effortsDiffer, t('composer.select.default')) : '?'
  }
  const [adding, setAdding] = useState(false)
  if (rows.length < 2) return null

  return (
    <section className="flex flex-col gap-2" data-lineup-comparisons>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-ink-soft">{t('benchmark.lineup.duels')}</h2>
        <span className="min-w-0 flex-1 text-xs text-ink-faint">{t('benchmark.lineup.duels.hint')}</span>
        <Button type="button" size="sm" variant="ghost" icon={<Plus size={14} />} disabled={comparisons.length >= MAX_BENCHMARK_COMPARISONS} onClick={() => setAdding(true)}>
          {t('benchmark.lineup.duels.add')}
        </Button>
      </div>
      {comparisons.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {comparisons.map((comparison, index) => {
            const names = comparison.keys.map(titleOf).join(t('benchmark.lineup.duels.vs'))
            const label = comparison.title ? `${comparison.title} · ${names}` : names
            return (
              <li key={index} className="flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-high py-0.5 pr-0.5 pl-2 text-xs" data-lineup-comparison>
                <Swords size={13} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 truncate">{label}</span>
                <IconButton type="button" size="sm" label={t('benchmark.lineup.duels.remove', { name: label })} onClick={() => onChange(comparisons.filter((_, other) => other !== index))}><X size={13} /></IconButton>
              </li>
            )
          })}
        </ul>
      ) : null}
      {adding ? <AddComparisonDialog rows={rows} titleOf={titleOf} onClose={() => setAdding(false)} onAdd={(comparison) => { onChange([...comparisons, comparison]); setAdding(false) }} /> : null}
    </section>
  )
}

function AddComparisonDialog({ rows, titleOf, onClose, onAdd }: {
  rows: LineupRow[]
  titleOf: (key: string) => string
  onClose: () => void
  onAdd: (comparison: LineupComparison) => void
}) {
  const t = useTranslate()
  const [picked, setPicked] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const toggle = (key: string) => setPicked((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : current.length < MAX_BENCHMARK_COMPARISON_VARIANTS ? [...current, key] : current))
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={t('benchmark.lineup.duels.dialogTitle')}
      confirmLabel={t('benchmark.lineup.duels.create')}
      confirmDisabled={picked.length < 2}
      size="wide"
      onConfirm={() => onAdd({ title: title.trim() || null, keys: picked })}
    >
      <p>{t('benchmark.lineup.duels.pick', { max: MAX_BENCHMARK_COMPARISON_VARIANTS })}</p>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" data-comparison-picker>
        {rows.map((row, index) => {
          const checked = picked.includes(row.key)
          const full = !checked && picked.length >= MAX_BENCHMARK_COMPARISON_VARIANTS
          return (
            <li key={row.key}>
              <label className={cx('flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm', full && 'cursor-not-allowed opacity-45')}>
                <input type="checkbox" checked={checked} disabled={full || !row.config} onChange={() => toggle(row.key)} className="size-4 accent-[var(--sg-accent)]" />
                <span className="w-5 text-right text-xs text-ink-faint tabular-nums">{index + 1}</span>
                <AgentIcon agent={row.agent} size={14} />
                <span className="min-w-0 truncate text-ink">{titleOf(row.key)}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <Field
        label={t('benchmark.lineup.duels.name')}
        value={title}
        maxLength={MAX_BENCHMARK_COMPARISON_TITLE_CHARS}
        placeholder={t('benchmark.lineup.duels.namePlaceholder')}
        onChange={(event) => setTitle(event.target.value)}
      />
    </ConfirmDialog>
  )
}
