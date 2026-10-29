import { useId, useRef, useState, type CSSProperties } from 'react'
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
  const maximum = Math.max(1, options.length - 1)
  const unavailable = disabled || options.length < 2
  // Discard a pending gesture if its model, options or saved value changed underneath it.
  const signature = JSON.stringify([model?.value, group.value, options.map((option) => option.value), unavailable])
  const gesture = useRef<string | null>(null)
  const [draft, setDraft] = useState<{ signature: string; value: number } | null>(null)
  const value = draft?.signature === signature ? draft.value : Math.max(0, index)
  const selected = options[draft?.signature === signature ? Math.round(value) : index]
  const cancel = () => { gesture.current = null; setDraft(null) }
  const commit = (next: number) => {
    cancel()
    const option = options[Math.max(0, Math.min(options.length - 1, Math.round(next)))]
    if (!unavailable && option && option.value !== group.value) group.onChange(option.value)
  }
  const label = selected?.label || group.value || t('composer.select.default')
  const modelLabel = model?.options.find((option) => option.value === model.value)?.label || model?.value
  const position = value / maximum

  return (
    <div className="effort-control" data-disabled={unavailable || undefined}>
      <div className="flex items-start gap-3 px-1">
        <span aria-hidden className="pt-1 text-ink-faint">{group.icon}</span>
        <div className="min-w-0 flex-1 text-center">
          <div className="text-sm font-semibold text-accent">{label}</div>
          {modelLabel ? <div className="truncate text-xs text-ink-soft">{modelLabel}</div> : null}
        </div>
        <span aria-hidden className="w-[15px]" />
      </div>
      <div className="effort-slider" data-dragging={draft?.signature === signature || undefined} style={{ '--effort-position': position } as CSSProperties}>
        <div aria-hidden className="effort-slider-track">
          <div className="effort-slider-fill" />
          <div className="effort-slider-ticks">
            {options.map((option, tick) => <span key={option.value} data-filled={tick <= value || undefined} />)}
          </div>
        </div>
        <input type="range" min={0} max={maximum} step="any"
          value={value} disabled={unavailable}
          aria-label={group.label} aria-valuetext={label}
          aria-describedby={selected?.hint ? id : undefined}
          onPointerDown={(event) => {
            if (unavailable) return
            gesture.current = signature
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerUp={(event) => {
            if (gesture.current === signature) commit(Number(event.currentTarget.value))
            else cancel()
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
          onBlur={cancel}
          onKeyDown={(event) => {
            const next = {
              ArrowRight: Math.round(value) + 1, ArrowUp: Math.round(value) + 1,
              ArrowLeft: Math.round(value) - 1, ArrowDown: Math.round(value) - 1,
              Home: 0, End: maximum, PageUp: Math.round(value) + 1, PageDown: Math.round(value) - 1,
            }[event.key]
            if (next !== undefined) { event.preventDefault(); commit(next) }
          }}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (gesture.current === signature) setDraft({ signature, value: next })
            else commit(next)
          }} />
      </div>
      {selected?.hint ? <p id={id} className="px-1 text-xs text-ink-faint">{selected.hint}</p> : null}
    </div>
  )
}
