import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { BookmarkPlus, ListOrdered, RotateCcw, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  MAX_BENCHMARK_TOTAL_VARIANTS,
  MAX_BENCHMARK_VARIANTS,
  defaultConfigFor,
  median,
  variantMeasure,
  type AgentConfig,
  type AgentKind,
  type BenchmarkDto,
  type BenchmarkRunDto,
} from '@sillage/protocol'
import { unavailableReason, useAgentAvailability } from '../../lib/agents'
import { ApiRequestError } from '../../lib/api'
import { comparisonsFromBenchmark, newRowKey, presetBody, type LineupRow, type MeasuredRows } from '../../lib/benchmark-lineup'
import { BENCHMARKS_KEY, useBenchmarkPresets, useUpdateBenchmarkLineup } from '../../lib/benchmarks'
import { useTranslate } from '../../lib/i18n'
import { useUserSettings } from '../../lib/user-settings'
import { Banner, Button, ConfirmDialog, IconButton } from '../ui'
import { LineupEditor, type LockedRow } from './LineupEditor'
import { SavePresetDialog } from './PresetDialogs'

const ACTIVE = new Set<BenchmarkRunDto['status']>(['running', 'checking'])

/** A run that left something behind: a session, measurements or a verdict, as the server counts it. */
function started(run: BenchmarkRunDto): boolean {
  return run.conversationId !== null || (run.status !== 'pending' && run.status !== 'cancelled')
}

/**
 * The lineup's rows as the dialog opens on it. What the runs announced (public name, price) goes
 * with each row, so a copy of a variant the CLI no longer lists keeps a name and a price.
 */
function rowsOf(benchmark: BenchmarkDto): LineupRow[] {
  return benchmark.variants.map((variant) => ({
    key: variant.id,
    agent: variant.config.agent,
    config: variant.config,
    label: variant.labelIsCustom ? variant.label : null,
    variantId: variant.id,
    known: { modelId: variant.model, publicName: variant.publicName ?? null, price: variant.listPrice },
  }))
}

/** What a save would send for an untouched lineup, to tell edits from the opening state. */
function entriesOf(rows: LineupRow[]): string {
  return JSON.stringify(rows.map((row) => ({ id: row.variantId, label: row.label?.trim() || null })))
}

/** A blind review stored on this device and not revealed yet: changing the lineup may re-letter it. */
function blindReviewOpen(benchmarkId: string): boolean {
  try {
    const raw = localStorage.getItem(`sillage.benchmark.blind.${benchmarkId}`)
    return raw !== null && (JSON.parse(raw) as { revealed?: boolean }).revealed === false
  } catch {
    return false
  }
}

/**
 * Continuing a benchmark: its lineup in order, new variants for models released since, names and
 * removals. Prompt, starting files and check script stay as they are so new variants are measured
 * on the same task; variants that ran keep their settings, so their runs stay comparable. One save
 * sends the whole ordered lineup.
 */
export default function LineupDialog({ benchmark, intent, onClose }: {
  benchmark: BenchmarkDto
  /** `add` opens with a new variant ready to edit, for the header's add action. */
  intent: 'edit' | 'add'
  onClose: () => void
}) {
  const t = useTranslate()
  const { data: availability } = useAgentAvailability()
  const { data: userSettings } = useUserSettings()
  const presets = useBenchmarkPresets()
  const save = useUpdateBenchmarkLineup()
  const queryClient = useQueryClient()
  const defaults = (agent: AgentKind): AgentConfig | undefined => userSettings?.agentDefaults[agent] ?? undefined
  const firstAgent = (): AgentKind => availability?.agents.find((entry) => entry.installed)?.agent ?? benchmark.variants[0]?.config.agent ?? 'claude'

  const existing = useMemo(() => rowsOf(benchmark), [benchmark])
  const [rows, setRows] = useState<LineupRow[]>(() => {
    if (intent !== 'add') return existing
    const last = existing[existing.length - 1]
    const config = last?.config ?? defaultConfigFor(firstAgent())
    return [...existing, { key: newRowKey(), agent: config.agent, config, label: null, known: last?.known }]
  })
  const [expandedKey, setExpandedKey] = useState<string | null>(() => (intent === 'add' ? rows[rows.length - 1]?.key ?? null : null))
  const [removed, setRemoved] = useState<Set<string>>(() => new Set())
  const [undo, setUndo] = useState<{ message: string; rows: LineupRow[] } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [savingPreset, setSavingPreset] = useState(false)
  // The lineup as it was when the window opened: removal is inferred from omission, so the server
  // checks the save against these ids instead of deleting a variant added elsewhere meanwhile.
  const [base, setBase] = useState(() => benchmark.variants.map((variant) => variant.id))
  const [initialEntries, setInitialEntries] = useState(() => entriesOf(existing))
  const [stale, setStale] = useState(false)
  // The list as the server has it now, once refetched after a conflict: starting over from the
  // copy cached before it would rebuild the same stale lineup and fail again.
  const [fresh, setFresh] = useState<BenchmarkDto | null>(null)
  const blind = useMemo(() => blindReviewOpen(benchmark.id), [benchmark.id])

  const locked = useMemo(() => new Map(benchmark.variants.map((variant): [string, LockedRow] => {
    const runs = benchmark.runs.filter((run) => run.variantId === variant.id)
    return [variant.id, {
      runs,
      cliVersion: runs.map((run) => run.cliVersion).find((value) => value !== null) ?? null,
      technicalLabel: variant.technicalLabel,
      removal: runs.some((run) => ACTIVE.has(run.status)) ? 'running' : runs.some(started) ? 'confirm' : 'free',
      automaticTitle: variant.labelIsCustom ? null : variant.label,
      model: variant.model,
      listPrice: variant.listPrice,
    }]
  })), [benchmark])

  // What each variant measured, for arranging by results: worst first is the order a video wants.
  const measured = useMemo((): MeasuredRows => new Map(benchmark.variants.map((variant) => {
    const ratings = benchmark.runs.filter((run) => run.variantId === variant.id).map((run) => run.rating)
    return [variant.id, {
      durationMs: variantMeasure(benchmark, variant.id, 'durationMs').median,
      costUsd: variantMeasure(benchmark, variant.id, 'costUsd').median,
      rating: median(ratings),
    }]
  })), [benchmark])

  const kept = rows.filter((row) => !removed.has(row.key))
  const added = kept.filter((row) => !row.variantId)
  const removing = [...removed].filter((key) => locked.has(key))
  const needsConfirmation = removing.some((key) => locked.get(key)?.removal === 'confirm')
  const launches = added.length * benchmark.repetitions
  const entries = kept.map((row) => (row.variantId
    ? { id: row.variantId, label: row.label?.trim() || null }
    : { config: row.config!, label: row.label?.trim() || null }))
  const changed = JSON.stringify(entries) !== initialEntries

  const problem = (() => {
    if (kept.length === 0) return t('benchmark.lineup.dialog.empty')
    if (kept.length > MAX_BENCHMARK_TOTAL_VARIANTS) return t('benchmark.lineup.dialog.limitTotal', { max: MAX_BENCHMARK_TOTAL_VARIANTS })
    if (added.length > MAX_BENCHMARK_VARIANTS) return t('benchmark.lineup.dialog.limitNew', { max: MAX_BENCHMARK_VARIANTS })
    // Numbered as the list shows them, struck rows included.
    for (const [index, row] of rows.entries()) {
      if (row.variantId || removed.has(row.key)) continue
      const reason = unavailableReason(availability?.agents.find((entry) => entry.agent === row.agent))
      if (reason) return t('benchmark.form.blocked.cli', { n: index + 1, reason })
    }
    return null
  })()

  const submit = (confirmRemoval: boolean) => {
    save.mutate(
      { id: benchmark.id, lineup: { variants: entries, confirmRemoval, base } },
      {
        onSuccess: () => { setConfirming(false); onClose() },
        onError: (error) => {
          // The error shows in the footer, which the confirmation would cover.
          setConfirming(false)
          if (error instanceof ApiRequestError && error.code === 'benchmark_lineup_changed') {
            setStale(true)
            setFresh(null)
            void queryClient.refetchQueries({ queryKey: BENCHMARKS_KEY }).then(() => {
              const current = queryClient.getQueryData<BenchmarkDto[]>(BENCHMARKS_KEY)?.find((entry) => entry.id === benchmark.id)
              if (current) setFresh(current)
            })
          }
        },
      },
    )
  }

  /** Starts over from the lineup as the refetch found it, dropping this window's edits. */
  const reload = () => {
    if (!fresh) return
    const current = rowsOf(fresh)
    setRows(current)
    setRemoved(new Set())
    setExpandedKey(null)
    setUndo(null)
    setBase(fresh.variants.map((variant) => variant.id))
    setInitialEntries(entriesOf(current))
    setStale(false)
    setFresh(null)
    save.reset()
  }

  const requestClose = () => {
    if (save.isPending) return
    if (changed) setDiscarding(true)
    else onClose()
  }

  /**
   * Escape belongs first to what is open inside the window: a keyboard move in progress, then an
   * open row. Only then does it close the window, and not over unsaved edits without asking.
   */
  const onEscapeKeyDown = (event: KeyboardEvent) => {
    // A save under way lands whatever happens to the window: nothing to discard, nothing to close.
    if (save.isPending) {
      event.preventDefault()
      return
    }
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('[data-lineup-row]') && active.getAttribute('aria-pressed') === 'true') {
      event.preventDefault()
      return
    }
    if (expandedKey !== null) {
      event.preventDefault()
      const key = expandedKey
      setExpandedKey(null)
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-lineup-row="${CSS.escape(key)}"] button[aria-controls]`)?.focus())
      return
    }
    if (changed) {
      event.preventDefault()
      setDiscarding(true)
    }
  }

  const change = (next: LineupRow[], message?: string) => {
    setUndo(message ? { message, rows } : null)
    setRows(next)
  }

  const summary = [
    added.length
      ? t(added.length === 1 ? 'benchmark.lineup.dialog.new.one' : 'benchmark.lineup.dialog.new', { count: added.length })
      : null,
    launches
      ? t(launches === 1 ? 'benchmark.lineup.dialog.launch.one' : 'benchmark.lineup.dialog.launch', { count: launches })
      : null,
    removing.length
      ? t(removing.length === 1 ? 'benchmark.lineup.dialog.removing.one' : 'benchmark.lineup.dialog.removing', { count: removing.length })
      : null,
  ].filter(Boolean).join(' · ') || t('benchmark.lineup.dialog.unchanged')

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) requestClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby="benchmark-lineup-description"
          className="surface fixed inset-0 top-[var(--sg-window-bar,0px)] z-50 flex min-h-0 flex-col overflow-clip border-line shadow-pop sm:inset-x-[max(1.25rem,calc((100vw-56rem)/2))] sm:inset-y-6 sm:top-[calc(1.5rem+var(--sg-window-bar,0px))] sm:rounded-lg sm:border"
          onEscapeKeyDown={onEscapeKeyDown}
          data-benchmark-lineup-dialog
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold"><ListOrdered size={18} className="shrink-0 text-accent" /><span className="truncate">{t('benchmark.lineup.dialog.title', { name: benchmark.name })}</span></Dialog.Title>
              <Dialog.Description id="benchmark-lineup-description" className="mt-1 text-sm text-ink-faint">{t('benchmark.lineup.dialog.description')}</Dialog.Description>
            </div>
            <Dialog.Close asChild><IconButton label={t('common.close')}><X size={19} /></IconButton></Dialog.Close>
          </div>

          <div className="@container/lineup min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            <div className="flex flex-col gap-3">
              {blind ? <Banner tone="caution">{t('benchmark.lineup.dialog.blind')}</Banner> : null}
              {stale ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-caution/40 bg-caution/10 px-3 py-2 text-sm" role="alert" data-lineup-stale>
                  <p className="min-w-0 flex-1 text-ink">{t('benchmark.lineup.dialog.changed')}</p>
                  <Button type="button" size="sm" variant="secondary" icon={<RotateCcw size={14} />} busy={fresh === null} onClick={reload} data-lineup-reload>{t('benchmark.lineup.dialog.reload')}</Button>
                </div>
              ) : null}
              <LineupEditor
                rows={rows}
                onRowsChange={change}
                expandedKey={expandedKey}
                onExpandedKeyChange={setExpandedKey}
                maxRows={MAX_BENCHMARK_TOTAL_VARIANTS}
                canAdd={kept.length < MAX_BENCHMARK_TOTAL_VARIANTS && added.length < MAX_BENCHMARK_VARIANTS}
                remaining={Math.min(MAX_BENCHMARK_TOTAL_VARIANTS - kept.length, MAX_BENCHMARK_VARIANTS - added.length)}
                addLimit={kept.length >= MAX_BENCHMARK_TOTAL_VARIANTS
                  ? t('benchmark.lineup.dialog.limitTotal', { max: MAX_BENCHMARK_TOTAL_VARIANTS })
                  : t('benchmark.lineup.dialog.limitNew', { max: MAX_BENCHMARK_VARIANTS })}
                defaults={defaults}
                firstAgent={firstAgent}
                availability={availability?.agents}
                locked={locked}
                removed={removed}
                onRemoveLocked={(key) => { setRemoved(new Set([...removed, key])); if (expandedKey === key) setExpandedKey(null) }}
                onRestoreLocked={(key) => setRemoved(new Set([...removed].filter((entry) => entry !== key)))}
                measured={measured}
                undo={undo ? { message: undo.message, onUndo: () => { setRows(undo.rows); setUndo(null) } } : null}
                heading={<h3 className="text-sm font-medium text-ink-soft">{t('benchmark.form.variants')}</h3>}
                // Never disabled: above the preset limit its window says why it cannot save, which a
                // greyed-out icon could only tell a mouse, not a keyboard or a finger.
                toolbar={
                  <IconButton type="button" size="sm" label={t('benchmark.lineup.dialog.savePreset')} onClick={() => setSavingPreset(true)}>
                    <BookmarkPlus size={15} />
                  </IconButton>
                }
              />
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-line px-4 py-3 sm:px-6">
            <div className="mr-auto min-w-0 flex-1 basis-56">
              <p className="text-sm text-ink" data-lineup-summary>{summary}</p>
              {problem ? <p className="text-xs text-caution">{problem}</p> : null}
              {save.error && !stale ? <p className="text-xs text-critical" role="alert" data-lineup-error>{save.error.message}</p> : null}
            </div>
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={requestClose}>{t('dialog.cancel')}</Button>
            <Button
              type="button"
              disabled={!changed || problem !== null || stale}
              busy={save.isPending && !confirming}
              onClick={() => (needsConfirmation ? setConfirming(true) : submit(false))}
              data-lineup-save
            >
              {t('benchmark.lineup.dialog.save')}
            </Button>
          </div>

          <ConfirmDialog
            open={confirming}
            onOpenChange={(open) => { if (!open && !save.isPending) setConfirming(false) }}
            title={t(removing.length === 1 ? 'benchmark.lineup.dialog.confirmTitle.one' : 'benchmark.lineup.dialog.confirmTitle', { count: removing.length })}
            confirmLabel={t('benchmark.lineup.dialog.confirm')}
            tone="critical"
            busy={save.isPending}
            onConfirm={() => submit(true)}
          >
            <p>{t('benchmark.lineup.dialog.confirmBody')}</p>
          </ConfirmDialog>

          <ConfirmDialog
            open={discarding}
            onOpenChange={setDiscarding}
            title={t('benchmark.lineup.dialog.discardTitle')}
            confirmLabel={t('benchmark.lineup.dialog.discard')}
            tone="critical"
            confirmDisabled={save.isPending}
            onConfirm={() => { if (save.isPending) return; setDiscarding(false); onClose() }}
          >
            <p>{t('benchmark.lineup.dialog.discardBody')}</p>
          </ConfirmDialog>

          {savingPreset ? (
            <SavePresetDialog
              open
              onOpenChange={(open) => { if (!open) setSavingPreset(false) }}
              presets={presets.data}
              defaultName={benchmark.name}
              prompt={benchmark.prompt}
              checkScript={benchmark.checkScript}
              variantCount={kept.length}
              blocked={null}
              build={(name, include) => presetBody({
                name,
                rows: kept,
                settings: { repetitions: benchmark.repetitions, concurrency: benchmark.concurrency, maxDurationMinutes: benchmark.maxDurationMinutes },
                comparisons: comparisonsFromBenchmark(benchmark, existing).filter((comparison) => comparison.keys.every((key) => !removed.has(key))),
                prompt: include.prompt ? benchmark.prompt : null,
                checkScript: include.checkScript ? benchmark.checkScript : null,
                checkTimeoutSeconds: benchmark.checkTimeoutSeconds,
              })}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
