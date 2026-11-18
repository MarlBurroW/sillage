import { ArrowLeft, ChevronDown, FileText, FlaskConical, Paperclip, X } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  DEFAULT_BENCHMARK_DURATION_MINUTES,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_BENCHMARK_CHECK_CHARS,
  MAX_CHECK_TIMEOUT_SECONDS,
  MIN_CHECK_TIMEOUT_SECONDS,
  MAX_BENCHMARK_NAME_CHARS,
  MAX_BENCHMARK_PROMPT_CHARS,
  MAX_BENCHMARK_VARIANTS,
  benchmarkPath,
  defaultConfigFor,
  type AgentConfig,
  type AgentKind,
  type AttachmentDto,
  type BenchmarkDto,
  type BenchmarkPresetDto,
} from '@sillage/protocol'
import { AttachmentTray } from '../components/chat/AttachmentTray'
import { ComparisonsField } from '../components/benchmark/ComparisonsField'
import { LineupEditor } from '../components/benchmark/LineupEditor'
import { ManagePresetsDialog, SavePresetDialog } from '../components/benchmark/PresetDialogs'
import { PresetsMenu } from '../components/benchmark/PresetsMenu'
import { InfoHint } from '../components/benchmark/VariantRow'
import { RunSettingsFields, parseRunSettings, runSettingsDraft, type RunSettingsDraft } from '../components/benchmark/RunSettingsFields'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { AGENT_LABELS } from '../components/AgentIcon'
import { Banner, Button, Field, IconButton, cx } from '../components/ui'
import { unavailableReason, useAgentAvailability } from '../lib/agents'
import { discardAttachment, formatBytes, uploadAttachment } from '../lib/attachments'
import {
  comparisonDrafts,
  comparisonsFromBenchmark,
  comparisonsFromDrafts,
  newRowKey,
  nextBenchmarkName,
  presetBody,
  pruneComparisons,
  rowsFromBenchmark,
  rowsFromPreset,
  type LineupComparison,
  type LineupRow,
} from '../lib/benchmark-lineup'
import { useBenchmarkPresets, useBenchmarks, useCreateBenchmark, useUpdateBenchmarkPreset } from '../lib/benchmarks'
import { formatCount, useTranslate } from '../lib/i18n'
import { useUserSettings } from '../lib/user-settings'
import { useMediaQuery } from '../lib/viewport'

/** Everything the form holds that a preset load or a sort may replace, so one snapshot undoes either. */
interface FormState {
  name: string
  prompt: string
  rows: LineupRow[]
  settings: RunSettingsDraft
  checkScript: string
  checkTimeout: string
  comparisons: LineupComparison[]
  /** Starting files kept from the benchmark this one copies; the server copies them. */
  inherited: { id: string; name: string; inputs: BenchmarkDto['inputs'] } | null
  /** Preset the form came from, and what it held, to say when the form drifted from it. */
  preset: { id: string; name: string; signature: string; prompt: boolean; checkScript: boolean } | null
}

const DEFAULT_SETTINGS = runSettingsDraft({ repetitions: 1, concurrency: 1, maxDurationMinutes: DEFAULT_BENCHMARK_DURATION_MINUTES })

/** What a preset compares against: what it would store if saved from the form right now. */
function presetSignature(form: Pick<FormState, 'rows' | 'settings' | 'comparisons' | 'prompt' | 'checkScript' | 'checkTimeout'>, include: { prompt: boolean; checkScript: boolean }): string {
  return JSON.stringify({
    rows: form.rows.map((row) => [row.config, row.label?.trim() || null]),
    settings: form.settings,
    comparisons: comparisonDrafts(form.comparisons, form.rows),
    prompt: include.prompt ? form.prompt.trim() : null,
    checkScript: include.checkScript ? form.checkScript : null,
    checkTimeout: include.checkScript ? form.checkTimeout : null,
  })
}

function withPreset(state: Omit<FormState, 'preset'>, preset: BenchmarkPresetDto): FormState {
  const include = { prompt: preset.prompt !== null, checkScript: preset.checkScript !== null }
  return { ...state, preset: { id: preset.id, name: preset.name, signature: presetSignature(state, include), ...include } }
}

/** The form a preset fills: its lineup, settings and comparisons, and the prompt or script when it kept them. */
function applyPreset(current: FormState, preset: BenchmarkPresetDto): FormState {
  const rows = rowsFromPreset(preset)
  return withPreset({
    ...current,
    rows,
    settings: runSettingsDraft({ repetitions: preset.repetitions, concurrency: preset.concurrency, maxDurationMinutes: preset.maxDurationMinutes }),
    comparisons: comparisonsFromDrafts(preset.comparisons, rows),
    prompt: preset.prompt ?? current.prompt,
    checkScript: preset.checkScript ?? current.checkScript,
    checkTimeout: preset.checkScript !== null ? String(preset.checkTimeoutSeconds) : current.checkTimeout,
  }, preset)
}

/** A recent benchmark's lineup, settings and comparisons; the task being typed stays. */
function applyBenchmarkLineup(current: FormState, benchmark: BenchmarkDto): FormState {
  const rows = rowsFromBenchmark(benchmark)
  return {
    ...current,
    rows,
    settings: runSettingsDraft(benchmark),
    comparisons: comparisonsFromBenchmark(benchmark, rows),
    preset: null,
  }
}

/** "New from this benchmark": the whole benchmark again, starting files included, under a new name. */
function copyOf(benchmark: BenchmarkDto): FormState {
  const rows = rowsFromBenchmark(benchmark)
  return {
    name: nextBenchmarkName(benchmark.name, MAX_BENCHMARK_NAME_CHARS),
    prompt: benchmark.prompt,
    rows,
    settings: runSettingsDraft(benchmark),
    checkScript: benchmark.checkScript ?? '',
    checkTimeout: String(benchmark.checkTimeoutSeconds),
    comparisons: comparisonsFromBenchmark(benchmark, rows),
    inherited: benchmark.inputs.length ? { id: benchmark.id, name: benchmark.name, inputs: benchmark.inputs } : null,
    preset: null,
  }
}

/**
 * Creation form: the task on one side (name, prompt, starting files, check script), the lineup on
 * the other, and a launch bar that stays in view with the first thing still missing. Nothing is
 * written until launch; the benchmark page then takes over as runs settle.
 */
export function NewBenchmarkPage() {
  const t = useTranslate()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const fromId = params.get('from')
  const presetId = params.get('preset')
  const promptId = useId()
  const checkId = useId()
  const { data: userSettings } = useUserSettings()
  const { data: availability } = useAgentAvailability()
  const { data: benchmarks, isError: benchmarksFailed } = useBenchmarks()
  const presets = useBenchmarkPresets()
  const create = useCreateBenchmark()
  const updatePreset = useUpdateBenchmarkPreset()
  const coarse = useMediaQuery('(pointer: coarse)')

  const defaults = (agent: AgentKind): AgentConfig | undefined => userSettings?.agentDefaults[agent] ?? undefined
  // The first installed CLI opens the list: a form starting on a missing CLI would fail at launch.
  const firstAgent = (): AgentKind => availability?.agents.find((entry) => entry.installed)?.agent ?? 'claude'

  const [form, setForm] = useState<FormState | null>(null)
  const [undo, setUndo] = useState<{ message: string; state: FormState } | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [inputs, setInputs] = useState<AttachmentDto[]>([])
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [checkOpen, setCheckOpen] = useState(false)
  const [typing, setTyping] = useState(false)
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)

  // Seed once from the right source, and only once it is known: a default row that a preset or
  // a copy replaces a moment later would flash and become the undo target.
  if (form === null) {
    const blank = (rows: LineupRow[]): FormState => ({
      name: '', prompt: '', rows, settings: DEFAULT_SETTINGS, checkScript: '', checkTimeout: String(DEFAULT_CHECK_TIMEOUT_SECONDS),
      comparisons: [], inherited: null, preset: null,
    })
    const source = fromId ? benchmarks?.find((entry) => entry.id === fromId) : undefined
    const preset = presetId ? presets.data?.find((entry) => entry.id === presetId) : undefined
    const waitingForSource = (fromId && !benchmarks && !benchmarksFailed) || (presetId && presets.isPending)
    if (source) {
      setForm(copyOf(source))
      if (source.checkScript) setCheckOpen(true)
    } else if (!waitingForSource && availability && userSettings !== undefined) {
      const agent = firstAgent()
      const seeded = blank([{ key: newRowKey(), agent, config: defaults(agent) ?? defaultConfigFor(agent), label: null }])
      setForm(preset ? applyPreset(seeded, preset) : seeded)
    }
  }

  // The prompt grows with its text up to most of the screen, then scrolls inside.
  useLayoutEffect(() => {
    const element = prompt.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight + 2}px`
  }, [form?.prompt])

  if (!form) {
    return <p role="status" className="p-6 text-sm text-ink-faint">{t('schedule.loading')}</p>
  }

  /** Applies a change; one that names itself can be undone until the next edit. */
  const update = (change: Partial<FormState>, undoMessage?: string) => {
    setUndo(undoMessage ? { message: undoMessage, state: form } : null)
    setForm({ ...form, ...change })
    // A failed preset update stops being news once the form moves on.
    if (updatePreset.isError) updatePreset.reset()
  }
  const replace = (next: FormState, undoMessage: string) => {
    setUndo({ message: undoMessage, state: form })
    setForm(next)
    setExpandedKey(null)
    if (updatePreset.isError) updatePreset.reset()
  }

  // Same upload path as the composer: the server copies these for each run at creation.
  const inheritedCount = form.inherited?.inputs.length ?? 0
  const addFiles = async (files: FileList | null) => {
    const picked = [...(files ?? [])].slice(0, Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - inheritedCount - inputs.length))
    setUploadError(null)
    setUploading((count) => count + picked.length)
    for (const file of picked) {
      try {
        const uploaded = await uploadAttachment(file)
        setInputs((current) => [...current, uploaded])
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err))
      } finally {
        setUploading((count) => count - 1)
      }
    }
  }
  const removeInput = (id: string) => {
    setInputs((current) => current.filter((entry) => entry.id !== id))
    void discardAttachment(id).catch(() => undefined)
  }

  const run = parseRunSettings(form.settings)
  const timeout = Number(form.checkTimeout)
  const timeoutValid = !form.checkScript.trim() || (Number.isInteger(timeout) && timeout >= MIN_CHECK_TIMEOUT_SECONDS && timeout <= MAX_CHECK_TIMEOUT_SECONDS)
  const sessions = form.rows.length * (run?.repetitions ?? 0)
  const entry = (agent: AgentKind) => availability?.agents.find((item) => item.agent === agent)

  // The first thing still missing, in reading order: the bar names it instead of a mute button.
  const blocking = (() => {
    if (!form.name.trim()) return t('benchmark.form.blocked.name')
    if (!form.prompt.trim()) return t('benchmark.form.blocked.prompt')
    if (uploading > 0) return t('benchmark.form.blocked.uploading')
    if (form.rows.length === 0) return t('benchmark.form.blocked.empty')
    // A continued benchmark holds up to twice what one launch may start: a copy of it must be trimmed.
    if (form.rows.length > MAX_BENCHMARK_VARIANTS) {
      return t('benchmark.form.blocked.tooMany', { max: MAX_BENCHMARK_VARIANTS, extra: form.rows.length - MAX_BENCHMARK_VARIANTS })
    }
    const broken = form.rows.findIndex((row) => !row.config)
    if (broken >= 0) return t('benchmark.form.blocked.invalid', { n: broken + 1 })
    for (const [index, row] of form.rows.entries()) {
      const reason = unavailableReason(entry(row.agent))
      if (reason) return t('benchmark.form.blocked.cli', { n: index + 1, reason })
    }
    if (!run) return t('benchmark.form.blocked.settings')
    if (!timeoutValid) return t('benchmark.form.blocked.timeout')
    return null
  })()
  const valid = blocking === null && run !== null

  const presetModified = form.preset !== null && presetSignature(form, form.preset) !== form.preset.signature
  const validRows = form.rows.filter((row) => row.config)
  const defaultPresetName = (() => {
    const counts = new Map<AgentKind, number>()
    for (const row of validRows) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1)
    return [...counts.entries()].map(([agent, count]) => (count > 1 ? `${AGENT_LABELS[agent]} ×${count}` : AGENT_LABELS[agent])).join(' + ')
  })()
  const presetSettings = run ?? { repetitions: 1, concurrency: 1, maxDurationMinutes: DEFAULT_BENCHMARK_DURATION_MINUTES }
  const hasScript = form.checkScript.trim() !== ''
  const buildPreset = (name: string, include: { prompt: boolean; checkScript: boolean }) => presetBody({
    name,
    rows: form.rows,
    settings: presetSettings,
    comparisons: form.comparisons,
    prompt: include.prompt ? form.prompt : null,
    checkScript: include.checkScript ? form.checkScript : null,
    // The typed time limit belongs to the script: a preset without it, or a hidden field left
    // blank, keeps the default rather than an empty field read as zero.
    checkTimeoutSeconds: include.checkScript && hasScript && timeoutValid ? timeout : DEFAULT_CHECK_TIMEOUT_SECONDS,
  })
  // A preset stores what launches: at least one readable variant, settings that parse, and a script
  // time limit that does when the script goes in.
  const presetEmpty = validRows.length === 0 ? t('benchmark.form.blocked.empty') : null
  const presetScriptBlocked = hasScript && !timeoutValid ? t('benchmark.form.blocked.timeout') : null

  const submit = () => {
    if (!valid || !run || create.isPending || form.rows.length > MAX_BENCHMARK_VARIANTS) return
    create.mutate(
      {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        // A label goes only when typed: an automatic name follows the model that answers.
        variants: form.rows.map((row) => ({ config: row.config!, ...(row.label?.trim() ? { label: row.label.trim() } : {}) })),
        ...run,
        attachmentIds: inputs.map((input) => input.id),
        inputsFrom: form.inherited?.id ?? null,
        checkScript: form.checkScript.trim() ? form.checkScript : null,
        ...(form.checkScript.trim() ? { checkTimeoutSeconds: timeout } : {}),
        comparisons: comparisonDrafts(form.comparisons, form.rows),
        presetId: form.preset?.id ?? null,
      },
      { onSuccess: (created) => navigate(benchmarkPath(created.id), { replace: true }) },
    )
  }

  // A launch starts every run at once and spends real quota: only the Launch button does it. Enter
  // in a field would submit the form implicitly, and the browser would pick its default button.
  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target
    if (event.key !== 'Enter' || !(target instanceof HTMLInputElement)) return
    if (!['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image'].includes(target.type)) event.preventDefault()
  }
  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Belt and braces: a button that forgot `type="button"` must never launch a benchmark.
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    if (submitter && !submitter.hasAttribute('data-benchmark-launch')) return
    submit()
  }
  const settingsBlocked = run ? null : t('benchmark.form.blocked.settings')
  // Updating rewrites the loaded preset with what it already holds: its script goes back in when it had one.
  const updateBlocked = presetEmpty ?? settingsBlocked ?? (form.preset?.checkScript ? presetScriptBlocked : null)

  // On a phone, the keyboard leaves little room: the launch bar steps aside while a field is edited.
  const onFocusChange = (event: FocusEvent<HTMLFormElement>, focused: boolean) => {
    const target = event.target as HTMLElement
    if (target.matches('input:not([type="file"]):not([type="checkbox"]), textarea')) setTyping(focused)
  }
  const checkFirstLine = form.checkScript.trim().split('\n')[0] ?? ''
  const promptLength = form.prompt.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 md:px-6">
        <MobileNavigationButton />
        <Link to="/benchmarks"><IconButton label={t('benchmark.back')}><ArrowLeft size={18} /></IconButton></Link>
        <FlaskConical size={19} className="shrink-0 text-ink-faint" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t('benchmark.new')}</h1>
        <PresetsMenu
          presets={presets.data}
          benchmarks={benchmarks}
          loaded={form.preset ? { name: form.preset.name, modified: presetModified } : null}
          updateBlocked={updateBlocked}
          onLoadPreset={(preset) => replace(applyPreset(form, preset), t('benchmark.preset.loaded', { name: preset.name }))}
          onLoadBenchmark={(benchmark) => replace(applyBenchmarkLineup(form, benchmark), t('benchmark.preset.loadedBenchmark', { name: benchmark.name }))}
          onSaveAs={() => setDialog('save')}
          onUpdate={() => {
            const loaded = form.preset
            if (!loaded || updateBlocked) return
            // The preset now matches what was sent; anything typed while it saves stays, and reads as a change.
            const sent = form
            updatePreset.mutate(
              { id: loaded.id, body: buildPreset(loaded.name, { prompt: loaded.prompt, checkScript: loaded.checkScript }) },
              { onSuccess: (saved) => setForm((current) => (current ? { ...current, preset: withPreset(sent, saved).preset } : current)) },
            )
          }}
          onManage={() => setDialog('manage')}
        />
      </header>

      <form
        className="@container/benchmark-form flex min-h-0 flex-1 flex-col overflow-y-auto"
        onSubmit={onFormSubmit}
        onKeyDown={onFormKeyDown}
        onFocus={(event) => onFocusChange(event, true)}
        onBlur={(event) => onFocusChange(event, false)}
      >
        <div className="mx-auto grid w-full max-w-3xl flex-1 content-start gap-6 p-4 md:p-6 @min-[64rem]/benchmark-form:max-w-[90rem] @min-[64rem]/benchmark-form:grid-cols-[minmax(0,1fr)_minmax(30rem,36rem)] @min-[64rem]/benchmark-form:gap-8">
          <div className="flex min-w-0 flex-col gap-5" data-benchmark-task>
            <Field
              label={t('benchmark.form.name')}
              value={form.name}
              maxLength={MAX_BENCHMARK_NAME_CHARS}
              placeholder={t('benchmark.form.namePlaceholder')}
              onChange={(event) => update({ name: event.target.value })}
            />

            <div className="flex flex-col gap-1.5">
              <div className="flex items-end justify-between gap-2">
                <label htmlFor={promptId} className="text-sm font-medium text-ink-soft">{t('benchmark.form.prompt')}</label>
                <span className={cx('text-xs tabular-nums', promptLength > MAX_BENCHMARK_PROMPT_CHARS * 0.9 ? 'text-caution' : 'text-ink-faint')} data-prompt-count>
                  {t('benchmark.form.promptCount', { count: formatCount(promptLength), max: formatCount(MAX_BENCHMARK_PROMPT_CHARS) })}
                </span>
              </div>
              <textarea
                ref={prompt}
                id={promptId}
                maxLength={MAX_BENCHMARK_PROMPT_CHARS}
                value={form.prompt}
                placeholder={t('benchmark.form.promptPlaceholder')}
                onChange={(event) => update({ prompt: event.target.value })}
                className="max-h-[60dvh] min-h-40 resize-none overflow-y-auto rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent md:min-h-56"
              />
              <p className="text-xs text-ink-faint">{t('benchmark.form.promptHint')}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink-soft">{t('benchmark.form.inputs')}</span>
                <input ref={fileInput} type="file" multiple hidden onChange={(event) => { void addFiles(event.target.files); event.target.value = '' }} />
                <IconButton type="button"
                  size="sm"
                  label={t('benchmark.form.addInput')}
                  title={t('benchmark.form.inputsHint', { max: MAX_ATTACHMENTS_PER_MESSAGE })}
                  disabled={inheritedCount + inputs.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip size={15} />
                </IconButton>
              </div>
              {form.inherited ? (
                <div className="flex items-start gap-2 rounded-md border border-line bg-surface-high px-3 py-2 text-xs" data-inherited-inputs>
                  <FileText size={14} className="mt-0.5 shrink-0 text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="text-ink-soft">{t('benchmark.form.inherited', { name: form.inherited.name })}</p>
                    <p className="truncate text-ink-faint">{form.inherited.inputs.map((input) => `${input.filename} (${formatBytes(input.sizeBytes)})`).join(', ')}</p>
                  </div>
                  <IconButton type="button" size="sm" label={t('benchmark.form.inheritedRemove')} onClick={() => update({ inherited: null })}><X size={14} /></IconButton>
                </div>
              ) : null}
              <AttachmentTray attachments={inputs} uploading={uploading} onRemove={removeInput} />
              {!form.inherited && inputs.length === 0 && uploading === 0 ? <p className="text-xs text-ink-faint">{t('benchmark.form.inputsHint', { max: MAX_ATTACHMENTS_PER_MESSAGE })}</p> : null}
              {uploadError ? <Banner>{uploadError}</Banner> : null}
            </div>

            <div className="rounded-lg border border-line" data-benchmark-check-block>
              <button
                type="button"
                aria-expanded={checkOpen}
                aria-controls={checkId}
                onClick={() => setCheckOpen((open) => !open)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-soft">{t('benchmark.form.check')}</span>
                  <span className="block truncate font-mono text-xs text-ink-faint">
                    {checkFirstLine ? t('benchmark.form.checkSummary', { line: checkFirstLine, seconds: form.checkTimeout }) : t('benchmark.form.checkNone')}
                  </span>
                </span>
                <ChevronDown size={16} className={cx('shrink-0 text-ink-faint transition-transform', checkOpen && 'rotate-180')} />
              </button>
              {checkOpen ? (
                <div id={checkId} className="flex flex-col gap-2 border-t border-line px-3 pt-2 pb-3">
                  <textarea
                    aria-label={t('benchmark.form.check')}
                    rows={5}
                    spellCheck={false}
                    maxLength={MAX_BENCHMARK_CHECK_CHARS}
                    value={form.checkScript}
                    placeholder={t('benchmark.form.checkPlaceholder')}
                    onChange={(event) => update({ checkScript: event.target.value })}
                    className="rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
                  />
                  <details className="text-xs text-ink-faint">
                    <summary className="cursor-pointer py-1 text-ink-soft">{t('benchmark.form.checkContext')}</summary>
                    <p className="mt-1">{t('benchmark.form.checkHint')}</p>
                    <p className="mt-1 font-mono">SILLAGE_RUN_DIR SILLAGE_RESPONSE_FILE SILLAGE_RUN_STATUS SILLAGE_VARIANT SILLAGE_AGENT SILLAGE_MODEL SILLAGE_EFFORT SILLAGE_REPETITION</p>
                  </details>
                  {form.checkScript.trim() ? (
                    <div className="max-w-56">
                      <Field
                        label={t('benchmark.form.checkTimeout')}
                        type="number"
                        min={MIN_CHECK_TIMEOUT_SECONDS}
                        max={MAX_CHECK_TIMEOUT_SECONDS}
                        error={timeoutValid ? undefined : t('benchmark.form.checkTimeoutInvalid', { min: MIN_CHECK_TIMEOUT_SECONDS, max: MAX_CHECK_TIMEOUT_SECONDS })}
                        value={form.checkTimeout}
                        onChange={(event) => update({ checkTimeout: event.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="@container/lineup flex min-w-0 flex-col gap-5" data-benchmark-lineup-column>
            <LineupEditor
              rows={form.rows}
              onRowsChange={(rows, undoMessage) => update({ rows, comparisons: pruneComparisons(form.comparisons, rows) }, undoMessage)}
              expandedKey={expandedKey}
              onExpandedKeyChange={setExpandedKey}
              maxRows={MAX_BENCHMARK_VARIANTS}
              canAdd={form.rows.length < MAX_BENCHMARK_VARIANTS}
              remaining={MAX_BENCHMARK_VARIANTS - form.rows.length}
              addLimit={t('benchmark.lineup.limit', { max: MAX_BENCHMARK_VARIANTS })}
              defaults={defaults}
              firstAgent={firstAgent}
              availability={availability?.agents}
              undo={undo ? { message: undo.message, onUndo: () => { setForm(undo.state); setUndo(null); setExpandedKey(null) } } : null}
              heading={<>
                <h2 className="text-sm font-medium text-ink-soft">{t('benchmark.form.variants')}</h2>
                <InfoHint label={t('benchmark.form.variantsInfo')}>
                  <span className="flex flex-col gap-1.5"><span>{t('benchmark.form.variantsHint')}</span><span>{t('benchmark.form.unattended')}</span></span>
                </InfoHint>
                {form.preset ? (
                  <span className="truncate text-xs text-ink-faint" data-preset-tag>
                    {t('benchmark.preset.from', { name: form.preset.name })}{presetModified ? ` · ${t('benchmark.preset.modified')}` : ''}
                  </span>
                ) : null}
              </>}
            />
            <ComparisonsField
              rows={form.rows}
              comparisons={form.comparisons}
              onChange={(comparisons) => update({ comparisons })}
            />
            <div className="grid items-start gap-4 @min-[34rem]/lineup:grid-cols-3">
              <RunSettingsFields draft={form.settings} onChange={(settings) => update({ settings })} />
            </div>
          </div>
        </div>

        <div className={cx('sticky bottom-0 z-10 mt-auto border-t border-line bg-surface/95 backdrop-blur-sm', coarse && typing && 'hidden')} data-benchmark-launch-bar>
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:px-6 @min-[64rem]/benchmark-form:max-w-[90rem]">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink tabular-nums" data-benchmark-total>
                {t('benchmark.form.sessions', {
                  variants: t(form.rows.length === 1 ? 'benchmark.preset.variants.one' : 'benchmark.preset.variants', { count: form.rows.length }),
                  runs: t((run?.repetitions ?? 0) === 1 ? 'benchmark.form.runsCount.one' : 'benchmark.form.runsCount', { count: run?.repetitions ?? '?' }),
                  sessions: t(sessions === 1 ? 'benchmark.form.sessionsCount.one' : 'benchmark.form.sessionsCount', { count: sessions }),
                })}
              </p>
              {create.isError ? <p className="text-xs text-critical">{create.error.message}</p>
                : blocking ? <p className="text-xs text-caution" data-benchmark-blocking>{blocking}</p>
                  : <p className="flex items-center gap-1 text-xs text-ink-faint">
                    <span className="truncate">{t('benchmark.form.isolationShort')}</span>
                    <InfoHint label={t('benchmark.form.isolationTitle')} size={13}>{t('benchmark.form.isolation')}</InfoHint>
                  </p>}
              {updatePreset.isError ? <p className="text-xs text-critical" data-preset-update-error>{t('benchmark.preset.updateFailed', { message: updatePreset.error.message })}</p> : null}
            </div>
            <Button type="submit" disabled={!valid} busy={create.isPending} icon={<FlaskConical size={15} />} data-benchmark-launch>
              {t('benchmark.form.launch')}
            </Button>
          </div>
        </div>
      </form>

      {dialog === 'save' ? (
        <SavePresetDialog
          open
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          presets={presets.data}
          defaultName={form.preset?.name ?? defaultPresetName}
          prompt={form.prompt.trim() ? form.prompt : null}
          checkScript={form.checkScript.trim() ? form.checkScript : null}
          variantCount={form.rows.length}
          blocked={form.rows.some((row) => !row.config) ? t('benchmark.preset.save.invalid') : (presetEmpty ?? settingsBlocked)}
          blockedWithScript={presetScriptBlocked}
          build={buildPreset}
          onSaved={(preset) => setForm(withPreset(form, preset))}
        />
      ) : null}
      <ManagePresetsDialog
        open={dialog === 'manage'}
        onOpenChange={(open) => { if (!open) setDialog(null) }}
        presets={presets.data}
        onLoad={(preset) => replace(applyPreset(form, preset), t('benchmark.preset.loaded', { name: preset.name }))}
      />
    </div>
  )
}
