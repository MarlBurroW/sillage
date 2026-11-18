import { BookmarkPlus, ChevronDown, Pencil, Trash2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  MAX_BENCHMARK_COMPARISONS,
  MAX_BENCHMARK_COMPARISON_TITLE_CHARS,
  MAX_BENCHMARK_COMPARISON_VARIANTS,
  variantAgent,
  type BenchmarkComparison,
  type BenchmarkDto,
} from '@sillage/protocol'
import { useUpdateBenchmarkComparisons } from '../../lib/benchmarks'
import { useTranslate } from '../../lib/i18n'
import { uuidv4 } from '../../lib/uuid'
import { useMediaQuery } from '../../lib/viewport'
import { AgentIcon } from '../AgentIcon'
import { Banner, Button, ConfirmDialog, Field, IconButton, Menu, MenuCheckboxItem, cx } from '../ui'

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id))

/**
 * What to compare: the variants picked by hand (the first one is the baseline), and the
 * comparisons kept with the benchmark, applied in one click. A saved comparison is what the
 * shared page features and what becomes a slide.
 *
 * With two variants there is nothing to pick (`pickable` off), but the comparisons kept with the
 * benchmark still need a place to be applied, renamed and deleted, and the duel can be saved.
 */
export function ComparisonPicker({ benchmark, selected, onChange, nameOf, pickable = true }: {
  benchmark: BenchmarkDto
  selected: string[]
  onChange: (ids: string[]) => void
  nameOf: (variantId: string) => { label: ReactNode; text: string }
  pickable?: boolean
}) {
  const t = useTranslate()
  const phone = useMediaQuery('(max-width: 639px)')
  const save = useUpdateBenchmarkComparisons()
  // Null while closed; `comparison` is set when renaming an existing one.
  const [editing, setEditing] = useState<{ comparison: BenchmarkComparison | null; title: string } | null>(null)
  // The chip last clicked: several comparisons may name the same variants (a pruned trio, say),
  // and each must be reachable for renaming or deleting, not only the first that matches.
  const [chosen, setChosen] = useState<string | null>(null)
  const full = selected.length >= MAX_BENCHMARK_COMPARISON_VARIANTS
  const matching = benchmark.comparisons.filter((comparison) => sameSet(comparison.variantIds, selected))
  const active = matching.find((comparison) => comparison.id === chosen) ?? matching[0] ?? null
  const comparisonName = (comparison: BenchmarkComparison) =>
    comparison.title || comparison.variantIds.map((id) => nameOf(id).text).join(' vs ')
  const toggle = (variantId: string) =>
    onChange(selected.includes(variantId) ? selected.filter((id) => id !== variantId) : full ? selected : [...selected, variantId])

  const write = (comparisons: BenchmarkComparison[]) =>
    save.mutate({ id: benchmark.id, comparisons }, { onSuccess: () => setEditing(null) })
  const confirm = () => {
    if (!editing) return
    const title = editing.title.trim() || null
    if (editing.comparison) {
      write(benchmark.comparisons.map((comparison) => (comparison.id === editing.comparison!.id ? { ...comparison, title } : comparison)))
    } else {
      const id = uuidv4()
      setChosen(id)
      write([...benchmark.comparisons, { id, title, variantIds: selected }])
    }
  }

  const chips = (
    <div role="group" aria-label={t('benchmark.compare.pick')} className="flex flex-wrap gap-1.5" data-compare-picker>
      {benchmark.variants.map((variant) => {
        const position = selected.indexOf(variant.id)
        const checked = position >= 0
        return (
          <button
            key={variant.id}
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={!checked && full}
            onClick={() => toggle(variant.id)}
            data-compare-chip={variant.id}
            className={cx(
              'inline-flex h-10 max-w-64 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors md:h-8 pointer-coarse:h-10',
              'disabled:pointer-events-none disabled:opacity-45',
              checked ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
            )}
          >
            {checked ? <span className="grid size-4 shrink-0 place-items-center rounded-sm bg-accent text-[0.625rem] font-bold text-accent-ink">{position + 1}</span> : null}
            <AgentIcon agent={variantAgent(variant)} size={13} />
            <span className="truncate">{nameOf(variant.id).label}</span>
          </button>
        )
      })}
    </div>
  )

  const menu = (
    <Menu align="start" trigger={(
      <Button size="sm" variant="secondary" icon={<ChevronDown size={14} />}>
        {t('benchmark.compare.pickCount', { count: selected.length })}
      </Button>
    )}>
      {benchmark.variants.map((variant) => (
        <MenuCheckboxItem key={variant.id} checked={selected.includes(variant.id)} disabled={!selected.includes(variant.id) && full} onCheckedChange={() => toggle(variant.id)}>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <AgentIcon agent={variantAgent(variant)} size={13} />
            <span className="truncate">{nameOf(variant.id).label}</span>
          </span>
        </MenuCheckboxItem>
      ))}
    </Menu>
  )

  return (
    <div className="flex flex-col gap-3">
      {benchmark.comparisons.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" data-compare-saved>
          <span className="mr-1 text-xs text-ink-faint">{t('benchmark.compare.saved')}</span>
          {benchmark.comparisons.map((comparison) => {
            const current = comparison.id === active?.id
            return (
              <span key={comparison.id} className="inline-flex items-center">
                <button
                  type="button"
                  aria-pressed={current}
                  onClick={() => { setChosen(comparison.id); onChange(comparison.variantIds) }}
                  data-compare-saved-chip={comparison.id}
                  className={cx(
                    'inline-flex h-10 max-w-72 items-center rounded-md border px-2.5 text-sm transition-colors md:h-8 pointer-coarse:h-10',
                    current ? 'border-accent text-accent' : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
                  )}
                >
                  <span className="truncate">{comparisonName(comparison)}</span>
                </button>
                {current ? (
                  <IconButton size="sm" label={t('benchmark.compare.edit')} onClick={() => setEditing({ comparison, title: comparison.title ?? '' })}><Pencil size={13} /></IconButton>
                ) : null}
              </span>
            )
          })}
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">{pickable ? (phone ? menu : chips) : null}</div>
        <div className="flex shrink-0 items-center gap-1">
          {selected.length >= 2 && !active ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<BookmarkPlus size={14} />}
              disabled={benchmark.comparisons.length >= MAX_BENCHMARK_COMPARISONS}
              title={benchmark.comparisons.length >= MAX_BENCHMARK_COMPARISONS ? t('benchmark.compare.saveFull', { max: MAX_BENCHMARK_COMPARISONS }) : t('benchmark.compare.saveHint')}
              onClick={() => { save.reset(); setEditing({ comparison: null, title: '' }) }}
              data-compare-save
            >
              {t('benchmark.compare.save')}
            </Button>
          ) : null}
          {pickable && selected.length > 0 ? (
            <IconButton size="sm" label={t('benchmark.compare.clear')} onClick={() => onChange([])}><X size={15} /></IconButton>
          ) : null}
        </div>
      </div>
      {pickable && full ? <p className="text-xs text-ink-faint">{t('benchmark.compare.full', { max: MAX_BENCHMARK_COMPARISON_VARIANTS })}</p> : null}

      <ConfirmDialog
        open={editing !== null}
        onOpenChange={(open) => { if (!open) setEditing(null) }}
        title={t(editing?.comparison ? 'benchmark.compare.editTitle' : 'benchmark.compare.saveTitle')}
        confirmLabel={t('benchmark.settings.save')}
        busy={save.isPending}
        onConfirm={confirm}
      >
        <div className="flex flex-col gap-4">
          <Field
            label={t('benchmark.compare.titleField')}
            value={editing?.title ?? ''}
            maxLength={MAX_BENCHMARK_COMPARISON_TITLE_CHARS}
            placeholder={(editing?.comparison?.variantIds ?? selected).map((id) => nameOf(id).text).join(' vs ')}
            onChange={(event) => setEditing((current) => (current ? { ...current, title: event.target.value } : current))}
          />
          <p className="text-sm text-ink-soft">{t('benchmark.compare.saveExplanation')}</p>
          {editing?.comparison ? (
            <div>
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 size={14} />}
                busy={save.isPending}
                onClick={() => write(benchmark.comparisons.filter((comparison) => comparison.id !== editing.comparison!.id))}
              >
                {t('benchmark.compare.delete')}
              </Button>
            </div>
          ) : null}
          {save.error ? <Banner>{save.error.message}</Banner> : null}
        </div>
      </ConfirmDialog>
    </div>
  )
}
