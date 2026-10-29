import { useId, type CSSProperties } from 'react'
import { useTranslate } from '../../lib/i18n'
import type { SettingGroup } from './ComposerSettings'
import './effort-slider.css'

/** Use the CLI's ordered choices, including its automatic/default level when offered. */
export function EffortSlider({ group, model, disabled = false }: {
  group: SettingGroup
  model?: SettingGroup
  disabled?: boolean
}) {
  const t = useTranslate()
  const id = useId()
  const options = group.options.filter((option) => !option.disabled)
  const index = options.findIndex((option) => option.value === group.value)
  const selected = options[index]
  const label = selected?.label || group.value || t('composer.select.default')
  const modelLabel = model?.options.find((option) => option.value === model.value)?.label || model?.value
  const position = Math.max(0, index) / Math.max(1, options.length - 1)

  return (
    <div className="effort-control" data-disabled={disabled || options.length < 2 || undefined}>
      <div className="flex items-start gap-3 px-1">
        <span aria-hidden className="pt-1 text-ink-faint">{group.icon}</span>
        <div className="min-w-0 flex-1 text-center">
          <div className="text-sm font-semibold text-accent">{label}</div>
          {modelLabel ? <div className="truncate text-xs text-ink-soft">{modelLabel}</div> : null}
        </div>
        <span aria-hidden className="w-[15px]" />
      </div>
      <div className="effort-slider" style={{ '--effort-position': position } as CSSProperties}>
        <div aria-hidden className="effort-slider-track">
          <div className="effort-slider-fill" />
          <div className="effort-slider-ticks">
            {options.map((option) => <span key={option.value} />)}
          </div>
        </div>
        <input type="range" min={0} max={Math.max(1, options.length - 1)} step={1}
          value={Math.max(0, index)} disabled={disabled || options.length < 2}
          aria-label={group.label} aria-valuetext={label}
          aria-describedby={selected?.hint ? id : undefined}
          onChange={(event) => {
            const option = options[Number(event.target.value)]
            if (option) group.onChange(option.value)
          }} />
      </div>
      {selected?.hint ? <p id={id} className="px-1 text-xs text-ink-faint">{selected.hint}</p> : null}
    </div>
  )
}
