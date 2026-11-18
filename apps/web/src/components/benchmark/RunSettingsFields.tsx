import {
  MAX_BENCHMARK_CONCURRENCY,
  MAX_BENCHMARK_DURATION_MINUTES,
  MAX_BENCHMARK_REPETITIONS,
  MIN_BENCHMARK_DURATION_MINUTES,
  updateBenchmarkSettingsBodySchema,
  type UpdateBenchmarkSettingsBody,
} from '@sillage/protocol'
import { Field } from '../ui'
import { useTranslate } from '../../lib/i18n'

/** The fields as typed: a number input holds text until it is valid. */
export interface RunSettingsDraft {
  repetitions: string
  concurrency: string
  maxDuration: string
}

export function runSettingsDraft(settings: UpdateBenchmarkSettingsBody): RunSettingsDraft {
  return { repetitions: String(settings.repetitions), concurrency: String(settings.concurrency), maxDuration: String(settings.maxDurationMinutes) }
}

/** The settings to send, or null while a field is invalid. `minRepetitions` is what already started. */
export function parseRunSettings(draft: RunSettingsDraft, minRepetitions = 1): UpdateBenchmarkSettingsBody | null {
  const parsed = updateBenchmarkSettingsBodySchema.safeParse({
    repetitions: Number(draft.repetitions), concurrency: Number(draft.concurrency), maxDurationMinutes: Number(draft.maxDuration),
  })
  return parsed.success && parsed.data.repetitions >= minRepetitions ? parsed.data : null
}

/**
 * How much a benchmark runs: the same three fields when creating one and when adjusting it later.
 * The caller lays them out, in a row on the form and stacked in a dialog.
 */
export function RunSettingsFields({ draft, onChange, minRepetitions = 1 }: {
  draft: RunSettingsDraft
  onChange: (draft: RunSettingsDraft) => void
  /** Repetitions that already started cannot be dropped. */
  minRepetitions?: number
}) {
  const t = useTranslate()
  const shape = updateBenchmarkSettingsBodySchema.shape
  const repetitions = Number(draft.repetitions)
  return (
    <>
      <Field
        label={t('benchmark.form.repetitions')}
        hint={t('benchmark.form.repetitionsHint')}
        error={!shape.repetitions.safeParse(repetitions).success ? t('benchmark.form.repetitionsInvalid', { max: MAX_BENCHMARK_REPETITIONS })
          : repetitions < minRepetitions ? t('benchmark.settings.repetitionsStarted', { count: minRepetitions })
            : undefined}
        type="number"
        min={minRepetitions}
        max={MAX_BENCHMARK_REPETITIONS}
        step={1}
        value={draft.repetitions}
        onChange={(event) => onChange({ ...draft, repetitions: event.target.value })}
      />
      <Field
        label={t('benchmark.form.concurrency')}
        hint={t('benchmark.form.concurrencyHint')}
        error={shape.concurrency.safeParse(Number(draft.concurrency)).success ? undefined : t('benchmark.form.concurrencyInvalid', { max: MAX_BENCHMARK_CONCURRENCY })}
        type="number"
        min={1}
        max={MAX_BENCHMARK_CONCURRENCY}
        step={1}
        value={draft.concurrency}
        onChange={(event) => onChange({ ...draft, concurrency: event.target.value })}
      />
      <Field
        label={t('schedule.form.maxDuration')}
        hint={t('benchmark.form.maxDurationHint')}
        error={shape.maxDurationMinutes.safeParse(Number(draft.maxDuration)).success ? undefined : t('schedule.form.maxDurationInvalid', { max: MAX_BENCHMARK_DURATION_MINUTES })}
        type="number"
        min={MIN_BENCHMARK_DURATION_MINUTES}
        max={MAX_BENCHMARK_DURATION_MINUTES}
        step={1}
        value={draft.maxDuration}
        onChange={(event) => onChange({ ...draft, maxDuration: event.target.value })}
      />
    </>
  )
}
