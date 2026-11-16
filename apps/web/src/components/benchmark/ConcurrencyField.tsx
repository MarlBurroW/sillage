import { benchmarkConcurrencySchema, MAX_BENCHMARK_CONCURRENCY } from '@sillage/protocol'
import { Field } from '../ui'
import { useTranslate } from '../../lib/i18n'

export function ConcurrencyField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslate()
  return (
    <Field
      label={t('benchmark.form.concurrency')}
      hint={t('benchmark.form.concurrencyHint')}
      error={benchmarkConcurrencySchema.safeParse(Number(value)).success ? undefined : t('benchmark.form.concurrencyInvalid', { max: MAX_BENCHMARK_CONCURRENCY })}
      type="number"
      min={1}
      max={MAX_BENCHMARK_CONCURRENCY}
      step={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
