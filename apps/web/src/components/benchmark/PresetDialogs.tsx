import * as Dialog from '@radix-ui/react-dialog'
import { Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { MAX_BENCHMARK_PRESET_NAME_CHARS, MAX_BENCHMARK_VARIANTS, type AgentKind, type BenchmarkPresetBody, type BenchmarkPresetDto } from '@sillage/protocol'
import { comparisonsFromDrafts, presetBody, presetNamed, rowsFromPreset } from '../../lib/benchmark-lineup'
import { useCreateBenchmarkPreset, useDeleteBenchmarkPreset, useUpdateBenchmarkPreset } from '../../lib/benchmarks'
import { relativeDate } from '../../lib/dates'
import { useTranslate } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { RenameInput } from '../nav/shared'
import { Banner, Button, ConfirmDialog, Field, IconButton, Switch } from '../ui'

/** "4 variants · 1 run each", the line that tells presets apart. */
export function presetSummary(t: ReturnType<typeof useTranslate>, variants: number, repetitions: number): string {
  return [
    t(variants === 1 ? 'benchmark.preset.variants.one' : 'benchmark.preset.variants', { count: variants }),
    t(repetitions === 1 ? 'benchmark.preset.runs.one' : 'benchmark.preset.runs', { count: repetitions }),
  ].join(' · ')
}

/**
 * Saves the lineup being edited as a preset. The lineup, its run settings and its comparisons
 * always go in; the prompt and the check script are task-specific, so only on request. A name
 * already used replaces that preset, as the button says.
 */
export function SavePresetDialog({ open, onOpenChange, presets, defaultName, prompt, checkScript, variantCount, blocked, blockedWithScript = null, build, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: BenchmarkPresetDto[] | undefined
  defaultName: string
  /** What could be included; null hides the option. */
  prompt: string | null
  checkScript: string | null
  variantCount: number
  /** Why the lineup cannot be saved as it is (unreadable variants); null when it can. */
  blocked: string | null
  /** Why the check script cannot go in as typed (its time limit): it only blocks a save that includes it. */
  blockedWithScript?: string | null
  build: (name: string, include: { prompt: boolean; checkScript: boolean }) => BenchmarkPresetBody
  onSaved?: (preset: BenchmarkPresetDto) => void
}) {
  const t = useTranslate()
  const [name, setName] = useState(defaultName)
  // Until toggled, the switches follow the preset a save would replace: replacing one that kept
  // its prompt must not silently strip it.
  const [promptChoice, setIncludePrompt] = useState<boolean | null>(null)
  const [checkChoice, setIncludeCheck] = useState<boolean | null>(null)
  const create = useCreateBenchmarkPreset()
  const update = useUpdateBenchmarkPreset()
  const existing = presetNamed(presets, name)
  const includePrompt = promptChoice ?? (existing ? existing.prompt !== null : false)
  const includeCheck = checkChoice ?? (existing ? existing.checkScript !== null : false)
  const tooMany = variantCount > MAX_BENCHMARK_VARIANTS
  const reason = blocked ?? (tooMany ? t('benchmark.preset.save.tooMany', { max: MAX_BENCHMARK_VARIANTS }) : null) ?? (includeCheck ? blockedWithScript : null)
  const busy = create.isPending || update.isPending
  const error = create.error ?? update.error

  const save = () => {
    if (!name.trim() || reason) return
    const body = build(name, { prompt: includePrompt, checkScript: includeCheck })
    const done = (preset: BenchmarkPresetDto) => { onSaved?.(preset); onOpenChange(false) }
    if (existing) update.mutate({ id: existing.id, body }, { onSuccess: done })
    else create.mutate(body, { onSuccess: done })
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('benchmark.preset.save.title')}
      confirmLabel={existing ? t('benchmark.preset.save.replace', { name: existing.name }) : t('benchmark.preset.save.confirm')}
      busy={busy}
      confirmDisabled={!name.trim() || reason !== null}
      onConfirm={save}
    >
      <div className="flex flex-col gap-4" data-preset-save>
        <Field label={t('benchmark.preset.save.name')} value={name} maxLength={MAX_BENCHMARK_PRESET_NAME_CHARS} autoFocus onChange={(event) => setName(event.target.value)} />
        <p className="text-xs text-ink-faint">{t('benchmark.preset.save.contents')}</p>
        {prompt !== null || checkScript !== null ? (
          <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {prompt !== null ? <Option label={t('benchmark.preset.save.prompt')} checked={includePrompt} onChange={setIncludePrompt} /> : null}
            {checkScript !== null ? <Option label={t('benchmark.preset.save.check')} checked={includeCheck} onChange={setIncludeCheck} /> : null}
          </div>
        ) : null}
        {existing ? <p className="text-xs text-caution">{t('benchmark.preset.save.exists')}</p> : null}
        {reason ? <Banner tone="caution">{reason}</Banner> : null}
        {error ? <Banner>{error.message}</Banner> : null}
      </div>
    </ConfirmDialog>
  )
}

function Option({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <p className="min-w-0 flex-1 text-sm text-ink">{label}</p>
      <Switch label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/**
 * The account's presets, to rename, delete or load. A window of its own: a list does not belong
 * under the button that opened it.
 */
export function ManagePresetsDialog({ open, onOpenChange, presets, onLoad }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: BenchmarkPresetDto[] | undefined
  onLoad: (preset: BenchmarkPresetDto) => void
}) {
  const t = useTranslate()
  const update = useUpdateBenchmarkPreset()
  const remove = useDeleteBenchmarkPreset()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<BenchmarkPresetDto | null>(null)
  const error = update.error ?? remove.error

  const rename = (preset: BenchmarkPresetDto, next: string) => {
    setRenaming(null)
    const name = next.trim()
    if (!name || name === preset.name) return
    // The route replaces the whole preset: send it back as it is stored, renamed. Unreadable
    // variants cannot travel back and stay out, which the row already says. Comparisons name
    // variants by position, so they are rebuilt over the variants that remain, and one that
    // involved a dropped variant goes rather than pointing at its neighbour.
    const rows = rowsFromPreset(preset)
    const readable = new Set(rows.filter((row) => row.config).map((row) => row.key))
    update.mutate({ id: preset.id, body: presetBody({
      name,
      rows,
      settings: { repetitions: preset.repetitions, concurrency: preset.concurrency, maxDurationMinutes: preset.maxDurationMinutes },
      comparisons: comparisonsFromDrafts(preset.comparisons, rows).filter((comparison) => comparison.keys.every((key) => readable.has(key))),
      prompt: preset.prompt,
      checkScript: preset.checkScript,
      checkTimeoutSeconds: preset.checkTimeoutSeconds,
    }) })
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby="benchmark-presets-description"
          className="surface fixed inset-0 top-[var(--sg-window-bar,0px)] z-50 flex min-h-0 flex-col overflow-clip border-line shadow-pop sm:inset-x-[max(1.25rem,calc((100vw-44rem)/2))] sm:inset-y-[10dvh] sm:rounded-lg sm:border"
          data-presets-manage
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold">{t('benchmark.preset.manage.title')}</Dialog.Title>
              <Dialog.Description id="benchmark-presets-description" className="mt-1 text-sm text-ink-faint">{t('benchmark.preset.manage.description')}</Dialog.Description>
            </div>
            <Dialog.Close asChild><IconButton label={t('common.close')}><X size={19} /></IconButton></Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
            {error ? <div className="mb-3"><Banner>{error.message}</Banner></div> : null}
            {!presets?.length ? (
              <p className="py-12 text-center text-sm text-ink-faint">{t('benchmark.preset.none')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {presets.map((preset) => {
                  const agents = [...new Set(preset.variants.map((variant) => variant.config?.agent ?? variant.agent).filter((agent): agent is AgentKind => agent !== null))]
                  const broken = preset.variants.filter((variant) => variant.problem).length
                  return (
                    <li key={preset.id} className="flex flex-wrap items-center gap-2 py-3" data-preset={preset.name}>
                      <div className="min-w-0 flex-1">
                        {renaming === preset.id ? (
                          <RenameInput
                            value={preset.name}
                            onCommit={(next) => rename(preset, next)}
                            onCancel={() => setRenaming(null)}
                            className="w-full rounded-md border border-accent bg-sunken px-2 py-1 text-sm text-ink outline-none"
                          />
                        ) : (
                          <p className="truncate text-sm font-medium" onDoubleClick={() => setRenaming(preset.id)}>{preset.name}</p>
                        )}
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
                          <span className="inline-flex items-center gap-1">{agents.map((agent) => <AgentIcon key={agent} agent={agent} size={12} />)}</span>
                          <span>{presetSummary(t, preset.variants.length, preset.repetitions)}</span>
                          {preset.comparisons.length ? <span>· {t(preset.comparisons.length === 1 ? 'benchmark.preset.comparisons.one' : 'benchmark.preset.comparisons', { count: preset.comparisons.length })}</span> : null}
                          {preset.prompt ? <span>· {t('benchmark.preset.manage.withPrompt')}</span> : null}
                          {preset.checkScript ? <span>· {t('benchmark.preset.manage.withCheck')}</span> : null}
                          {preset.lastUsedAt ? <span>· {t('benchmark.preset.manage.lastUsed', { date: relativeDate(preset.lastUsedAt) })}</span> : null}
                          {broken ? <span className="text-critical">· {t(broken === 1 ? 'benchmark.preset.manage.broken.one' : 'benchmark.preset.manage.broken', { count: broken })}</span> : null}
                        </p>
                      </div>
                      <IconButton size="sm" label={t('benchmark.preset.manage.rename', { name: preset.name })} onClick={() => setRenaming(preset.id)}><Pencil size={15} /></IconButton>
                      <IconButton size="sm" label={t('benchmark.preset.manage.delete', { name: preset.name })} onClick={() => setDeleting(preset)}><Trash2 size={15} /></IconButton>
                      <Button size="sm" variant="secondary" onClick={() => { onLoad(preset); onOpenChange(false) }}>{t('benchmark.preset.manage.load')}</Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(next) => { if (!next) setDeleting(null) }}
            title={t('benchmark.preset.manage.deleteTitle', { name: deleting?.name ?? '' })}
            confirmLabel={t('shell.delete')}
            tone="critical"
            busy={remove.isPending}
            onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
          >
            <p>{t('benchmark.preset.manage.deleteBody')}</p>
          </ConfirmDialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
