import { Check, Search, X } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'
import type { SettingGroup } from './ComposerSettings'

interface SettingsPanelProps {
  groups: SettingGroup[]
  disabled?: boolean
  /** MCP est un choix multiple, rendu après les choix uniques. */
  extra?: ReactNode
  feedback?: ReactNode
  onDone: () => void
  onClose: () => void
}

/** Vue complète : les choix s'appliquent sans fermer le panneau. */
export function SettingsPanel({ groups, disabled, extra, feedback, onDone, onClose }: SettingsPanelProps) {
  const t = useTranslate()
  const ordered = [
    ...groups.filter((group) => group.key === 'model'),
    ...groups.filter((group) => group.key === 'effort'),
    ...groups.filter((group) => group.key !== 'model' && group.key !== 'effort'),
  ]
  return (
    <>
      <SettingsHeading title={t('composer.settings.title')} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
        {ordered.map((group) => (
          <section key={group.key} className="border-b border-line py-4 last:border-0">
            <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-ink-soft">
              {group.icon}{group.label}
            </h3>
            {group.notice ? <p className="mb-2 text-xs text-caution">{group.notice}</p> : null}
            <SettingOptions group={group} disabled={disabled} compact={group.key === 'effort' || group.key === 'mode'} onPick={group.onChange} />
          </section>
        ))}
        {extra ? (
          <section className="py-4">
            <h3 className="mb-2 text-xs font-medium text-ink-soft">{t('cliDefaults.mcp.label')}</h3>
            {extra}
          </section>
        ) : null}
      </div>
      {feedback ? <div className="shrink-0 border-t border-line px-3 pt-2">{feedback}</div> : null}
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-line px-4 pt-3 pb-[max(0.75rem,var(--sg-safe-bottom))]">
        <p className="text-xs text-ink-faint">{t('composer.settings.immediate')}</p>
        <button type="button" onClick={onDone} className="min-h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {t('composer.settings.done')}
        </button>
      </footer>
    </>
  )
}

export function SettingsHeading({ title, onClose }: { title: string; onClose: () => void }) {
  const t = useTranslate()
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line py-2 pr-2 pl-4">
      <h2 tabIndex={-1} data-settings-heading className="text-sm font-semibold outline-none">{title}</h2>
      <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
        <X size={18} />
      </button>
    </header>
  )
}

/** Flèches pour parcourir ; Entrée/Espace pour choisir, sans fermeture accidentelle. */
export function SettingOptions({ group, onPick, disabled = false, compact = false }: {
  group: SettingGroup
  onPick: (value: string) => void
  disabled?: boolean
  compact?: boolean
}) {
  const t = useTranslate()
  const id = useId()
  const [query, setQuery] = useState('')
  const searchable = group.key === 'model' && group.options.length > 8
  const normalized = query.trim().toLocaleLowerCase()
  const options = searchable && normalized
    ? group.options.filter((option) => `${option.label} ${option.hint ?? ''}`.toLocaleLowerCase().includes(normalized))
    : group.options
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const selectable = options.flatMap((option, index) => option.disabled || disabled ? [] : [index])
  const checkedIndex = options.findIndex((option) => option.value === group.value)
  const tabIndex = selectable.includes(checkedIndex) ? checkedIndex : selectable[0]
  const selected = group.options.find((option) => option.value === group.value)

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (selectable.length === 0) return
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      const next = selectable[(selectable.indexOf(index) + step + selectable.length) % selectable.length]
      if (next !== undefined) items.current[next]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const edge = event.key === 'Home' ? selectable[0] : selectable[selectable.length - 1]
      if (edge !== undefined) items.current[edge]?.focus()
    }
  }

  return (
    <>
      {searchable ? (
        <label className="mb-2 flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-ink-faint">
          <Search size={16} className="shrink-0" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('composer.settings.searchModels')} placeholder={t('composer.settings.searchModels')} className="min-w-0 flex-1 bg-transparent py-2 text-base text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent" />
        </label>
      ) : null}
      <div role="radiogroup" aria-label={group.label} className={cx(compact ? 'grid gap-1.5' : 'flex flex-col gap-1', compact && (options.length <= 2 ? 'grid-cols-2' : 'grid-cols-3'))}>
        {options.map((option, index) => {
          const checked = option.value === group.value
          return (
            <button key={option.value} type="button" role="radio" aria-checked={checked}
              aria-describedby={compact && checked && option.hint ? `${id}-hint` : undefined}
              disabled={disabled || option.disabled}
              ref={(node) => { items.current[index] = node }}
              tabIndex={index === tabIndex ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => onPick(option.value)}
              className={cx(
                'flex min-h-11 min-w-0 items-center gap-2 rounded-md border text-left transition-colors',
                'hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                'disabled:pointer-events-none disabled:opacity-45',
                compact ? 'justify-center px-1.5 py-2 text-center text-xs' : 'px-3 py-2 text-sm',
                checked ? 'border-accent/40 bg-accent-wash' : compact ? 'border-line' : 'border-transparent',
                option.tone === 'caution' ? 'text-caution' : checked ? 'text-ink' : 'text-ink-soft',
              )}
            >
              <span className="min-w-0 flex-1 wrap-anywhere">
                <span className={cx('flex items-center gap-1.5 font-medium', compact && 'justify-center')}>
                  {option.icon ? <span className="shrink-0">{option.icon}</span> : null}{option.label}
                </span>
                {!compact && option.hint ? <span className="mt-0.5 block text-xs text-ink-faint">{option.hint}</span> : null}
              </span>
              {!compact ? <Check size={16} aria-hidden className={cx('shrink-0 text-accent', !checked && 'invisible')} /> : null}
            </button>
          )
        })}
      </div>
      {options.length === 0 ? <p className="px-3 py-4 text-sm text-ink-faint">{t('composer.settings.empty')}</p> : null}
      {compact && selected?.hint ? <p id={`${id}-hint`} className="mt-2 text-xs text-ink-faint">{selected.hint}</p> : null}
    </>
  )
}
