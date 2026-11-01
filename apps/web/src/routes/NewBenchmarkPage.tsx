import { ArrowLeft, FlaskConical, Paperclip, Plus } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  DEFAULT_BENCHMARK_DURATION_MINUTES,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_BENCHMARK_CHECK_CHARS,
  MAX_CHECK_TIMEOUT_SECONDS,
  MIN_CHECK_TIMEOUT_SECONDS,
  MAX_BENCHMARK_DURATION_MINUTES,
  MAX_BENCHMARK_NAME_CHARS,
  MAX_BENCHMARK_PROMPT_CHARS,
  MAX_BENCHMARK_REPETITIONS,
  MAX_BENCHMARK_VARIANTS,
  MAX_PARALLEL_BENCHMARK_RUNS,
  MIN_BENCHMARK_DURATION_MINUTES,
  benchmarkPath,
  defaultConfigFor,
  type AgentConfig,
  type AgentKind,
  type AttachmentDto,
  type BenchmarkConcurrency,
} from '@sillage/protocol'
import { AttachmentTray } from '../components/chat/AttachmentTray'
import { VariantEditor } from '../components/benchmark/VariantEditor'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Banner, Button, Field, IconButton, Select, cx } from '../components/ui'
import { useAgentAvailability } from '../lib/agents'
import { discardAttachment, uploadAttachment } from '../lib/attachments'
import { useCreateBenchmark } from '../lib/benchmarks'
import { useTranslate } from '../lib/i18n'
import { useSidebarHidden } from '../lib/sidebar'
import { useUserSettings } from '../lib/user-settings'

interface Draft {
  key: number
  config: AgentConfig
}

/**
 * Creation form: one prompt, a list of configurations to measure, and the run shape. Nothing is
 * written until launch; the benchmark page then takes over as runs settle.
 */
export function NewBenchmarkPage() {
  const t = useTranslate()
  const navigate = useNavigate()
  const sidebarHidden = useSidebarHidden()
  const promptId = useId()
  const { data: userSettings } = useUserSettings()
  const { data: availability } = useAgentAvailability()
  const create = useCreateBenchmark()

  const defaults = (agent: AgentKind): AgentConfig | undefined => userSettings?.agentDefaults[agent] ?? undefined
  // The first installed CLI opens the list: a form starting on a missing CLI would fail at launch.
  const firstAgent = (): AgentKind => availability?.agents.find((entry) => entry.installed)?.agent ?? 'claude'

  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [variants, setVariants] = useState<Draft[]>([])
  const [repetitions, setRepetitions] = useState('1')
  const [concurrency, setConcurrency] = useState<BenchmarkConcurrency>('sequential')
  const [maxDuration, setMaxDuration] = useState(String(DEFAULT_BENCHMARK_DURATION_MINUTES))
  const [nextKey, setNextKey] = useState(1)
  const [inputs, setInputs] = useState<AttachmentDto[]>([])
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const checkId = useId()
  const [checkScript, setCheckScript] = useState('')
  const [checkTimeout, setCheckTimeout] = useState(String(DEFAULT_CHECK_TIMEOUT_SECONDS))

  // Same upload path as the composer: the server copies these for each run at creation.
  const addFiles = async (files: FileList | null) => {
    const picked = [...(files ?? [])].slice(0, MAX_ATTACHMENTS_PER_MESSAGE - inputs.length)
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

  // Seed one variant once the CLI list is known, so the form never shows an empty list.
  if (variants.length === 0 && availability) {
    const agent = firstAgent()
    setVariants([{ key: 0, config: defaults(agent) ?? defaultConfigFor(agent) }])
  }

  const addVariant = () => {
    // Duplicate the last row: a benchmark usually varies one setting at a time.
    const last = variants[variants.length - 1]
    const agent = last?.config.agent ?? firstAgent()
    setVariants([...variants, { key: nextKey, config: last?.config ?? defaults(agent) ?? defaultConfigFor(agent) }])
    setNextKey(nextKey + 1)
  }

  const reps = Number(repetitions)
  const repsValid = Number.isInteger(reps) && reps >= 1 && reps <= MAX_BENCHMARK_REPETITIONS
  const duration = Number(maxDuration)
  const durationValid = Number.isInteger(duration) && duration >= MIN_BENCHMARK_DURATION_MINUTES && duration <= MAX_BENCHMARK_DURATION_MINUTES
  const timeout = Number(checkTimeout)
  const timeoutValid = !checkScript.trim() || (Number.isInteger(timeout) && timeout >= MIN_CHECK_TIMEOUT_SECONDS && timeout <= MAX_CHECK_TIMEOUT_SECONDS)
  const valid = Boolean(name.trim() && prompt.trim() && variants.length > 0 && repsValid && durationValid && timeoutValid && uploading === 0)
  const total = variants.length * (repsValid ? reps : 0)

  const submit = () => {
    if (!valid || create.isPending) return
    create.mutate(
      {
        name: name.trim(),
        prompt: prompt.trim(),
        variants: variants.map((variant) => ({ config: variant.config })),
        repetitions: reps,
        concurrency,
        maxDurationMinutes: duration,
        attachmentIds: inputs.map((input) => input.id),
        checkScript: checkScript.trim() ? checkScript : null,
        ...(checkScript.trim() ? { checkTimeoutSeconds: timeout } : {}),
      },
      { onSuccess: (created) => navigate(benchmarkPath(created.id), { replace: true }) },
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cx('flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 md:px-6', sidebarHidden && 'md:pl-14')}>
        <MobileNavigationButton />
        <Link to="/benchmarks"><IconButton label={t('benchmark.back')}><ArrowLeft size={18} /></IconButton></Link>
        <FlaskConical size={19} className="shrink-0 text-ink-faint" />
        <h1 className="text-base font-semibold">{t('benchmark.new')}</h1>
      </header>

      <form
        className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6"
        onSubmit={(event) => { event.preventDefault(); submit() }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Field
            label={t('benchmark.form.name')}
            value={name}
            maxLength={MAX_BENCHMARK_NAME_CHARS}
            placeholder={t('benchmark.form.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor={promptId} className="text-sm font-medium text-ink-soft">{t('benchmark.form.prompt')}</label>
            <textarea
              id={promptId}
              rows={7}
              maxLength={MAX_BENCHMARK_PROMPT_CHARS}
              value={prompt}
              placeholder={t('benchmark.form.promptPlaceholder')}
              onChange={(event) => setPrompt(event.target.value)}
              className="rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
            />
            <p className="text-xs text-ink-faint">{t('benchmark.form.promptHint')}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-soft">{t('benchmark.form.inputs')}</span>
            <AttachmentTray attachments={inputs} uploading={uploading} onRemove={removeInput} />
            <div>
              <input ref={fileInput} type="file" multiple hidden onChange={(event) => { void addFiles(event.target.files); event.target.value = '' }} />
              <Button type="button" variant="secondary" size="sm" icon={<Paperclip size={15} />} disabled={inputs.length >= MAX_ATTACHMENTS_PER_MESSAGE} onClick={() => fileInput.current?.click()}>
                {t('benchmark.form.addInput')}
              </Button>
            </div>
            <p className="text-xs text-ink-faint">{t('benchmark.form.inputsHint', { max: MAX_ATTACHMENTS_PER_MESSAGE })}</p>
            {uploadError ? <Banner>{uploadError}</Banner> : null}
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-ink-soft">{t('benchmark.form.variants')}</legend>
            <p className="text-xs text-ink-faint">{t('benchmark.form.variantsHint')}</p>
            <Banner tone="caution">{t('benchmark.form.unattended')}</Banner>
            <ul className="flex flex-col gap-3">
              {variants.map((variant) => (
                <VariantEditor
                  key={variant.key}
                  config={variant.config}
                  defaults={defaults}
                  removable={variants.length > 1}
                  onChange={(config) => setVariants(variants.map((entry) => (entry.key === variant.key ? { ...entry, config } : entry)))}
                  onRemove={() => setVariants(variants.filter((entry) => entry.key !== variant.key))}
                />
              ))}
            </ul>
            <div>
              <Button type="button" variant="secondary" size="sm" icon={<Plus size={15} />} disabled={variants.length >= MAX_BENCHMARK_VARIANTS} onClick={addVariant}>
                {t('benchmark.form.addVariant')}
              </Button>
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label={t('benchmark.form.repetitions')}
              hint={t('benchmark.form.repetitionsHint')}
              error={repsValid ? undefined : t('benchmark.form.repetitionsInvalid', { max: MAX_BENCHMARK_REPETITIONS })}
              type="number"
              min={1}
              max={MAX_BENCHMARK_REPETITIONS}
              value={repetitions}
              onChange={(event) => setRepetitions(event.target.value)}
            />
            <Select
              label={t('benchmark.form.concurrency')}
              value={concurrency}
              onChange={setConcurrency}
              options={[
                { value: 'sequential', label: t('benchmark.form.concurrency.sequential'), hint: t('benchmark.form.concurrency.sequentialHint') },
                { value: 'parallel', label: t('benchmark.form.concurrency.parallel'), hint: t('benchmark.form.concurrency.parallelHint', { max: MAX_PARALLEL_BENCHMARK_RUNS }) },
              ]}
            />
            <Field
              label={t('schedule.form.maxDuration')}
              hint={t('benchmark.form.maxDurationHint')}
              error={durationValid ? undefined : t('schedule.form.maxDurationInvalid', { max: MAX_BENCHMARK_DURATION_MINUTES })}
              type="number"
              min={MIN_BENCHMARK_DURATION_MINUTES}
              max={MAX_BENCHMARK_DURATION_MINUTES}
              value={maxDuration}
              onChange={(event) => setMaxDuration(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={checkId} className="text-sm font-medium text-ink-soft">{t('benchmark.form.check')}</label>
            <textarea
              id={checkId}
              rows={5}
              spellCheck={false}
              maxLength={MAX_BENCHMARK_CHECK_CHARS}
              value={checkScript}
              placeholder={t('benchmark.form.checkPlaceholder')}
              onChange={(event) => setCheckScript(event.target.value)}
              className="rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
            />
            <details className="text-xs text-ink-faint">
              <summary className="cursor-pointer py-1 text-ink-soft">{t('benchmark.form.checkContext')}</summary>
              <p className="mt-1">{t('benchmark.form.checkHint')}</p>
              <p className="mt-1 font-mono">SILLAGE_RUN_DIR SILLAGE_RESPONSE_FILE SILLAGE_RUN_STATUS SILLAGE_VARIANT SILLAGE_AGENT SILLAGE_MODEL SILLAGE_EFFORT SILLAGE_REPETITION</p>
            </details>
            {checkScript.trim() ? (
              <div className="max-w-56">
                <Field
                  label={t('benchmark.form.checkTimeout')}
                  type="number"
                  min={MIN_CHECK_TIMEOUT_SECONDS}
                  max={MAX_CHECK_TIMEOUT_SECONDS}
                  error={timeoutValid ? undefined : t('benchmark.form.checkTimeoutInvalid', { min: MIN_CHECK_TIMEOUT_SECONDS, max: MAX_CHECK_TIMEOUT_SECONDS })}
                  value={checkTimeout}
                  onChange={(event) => setCheckTimeout(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          <Banner tone="info">{t('benchmark.form.isolation')}</Banner>
          {create.isError ? <Banner>{create.error.message}</Banner> : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-xs text-ink-faint">{t('benchmark.form.total', { count: total })}</span>
            <Button type="submit" disabled={!valid} busy={create.isPending} icon={<FlaskConical size={15} />}>
              {t('benchmark.form.launch')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
