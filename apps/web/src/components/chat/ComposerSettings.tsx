import { TooltipButton } from '../ui/Tooltip'
import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslate } from '../../lib/i18n'
import { useMediaQuery } from '../../lib/viewport'
import { cx } from '../ui'
import { toolButtonClass } from './composer-buttons'
import { SettingOptions, SettingsHeading, SettingsPanel } from './SettingsPanel'

/**
 * Mark values removing a safeguard. Absent otherwise: an explicit neutral tone would merely name
 * absence of a signal.
 */
export type SettingTone = 'caution'

export interface SettingOption {
  value: string
  label: string
  hint?: string
  icon?: ReactNode
  disabled?: boolean
  tone?: SettingTone
}

/** Option retaining its original value union before widening. */
export type SettingChoice<V extends string> = Omit<SettingOption, 'value'> & { value: V }

/** Choices come from the CLI; layout belongs to the composer. */
export interface SettingGroup {
  key: string
  label: string
  icon?: ReactNode
  options: SettingOption[]
  value: string
  onChange: (value: string) => void
  /**
   * Difference between selected and applied values when the CLI requires restart. Absent almost all
   * the time.
   */
  notice?: string
  /**
   * Enabled value for two-state categories. When pinned, render a switch rather than a two-item
   * menu so state is visible and one click toggles.
   */
  active?: string
}

/**
 * Build a category without losing value types. Heterogeneous categories widen to string,
 * incompatible with narrower SettingGroup because onChange is contravariant. This is the sole
 * narrowing point back to protocol unions, validating membership first.
 */
export function setting<V extends string>(group: {
  key: string
  label: string
  icon?: ReactNode
  options: SettingChoice<V>[]
  value: V
  onChange: (value: V) => void
  notice?: string
  active?: V
}): SettingGroup {
  return {
    ...group,
    onChange: (value) => {
      if (group.options.some((option) => option.value === value && !option.disabled)) group.onChange(value as V)
    },
  }
}

export interface SummarySegment {
  key: string
  label: string
  tone?: SettingTone
}

/** Two categories combined into one chip always present beneath text. */
export const MODEL_EFFORT_KEYS: readonly string[] = ['model', 'effort']

export interface ComposerSettingsProps {
  groups: SettingGroup[]
  summary: SummarySegment[]
  /**
   * Categories beside model/effort in order; ignore unknown keys and model/effort already included
   * in the chip.
   */
  pinned: string[]
  onPinnedChange?: (next: string[]) => void
  /** Narrow phone composer: one chip opens the full panel without pins or a separate settings button. */
  narrow: boolean
  mcp?: ReactNode
  feedback?: ReactNode
  disabled?: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
}

/** Currently available pinned categories excluding model/effort. */
export function pinnedExtras(groups: SettingGroup[], pinned: string[]): SettingGroup[] {
  return pinned.flatMap((key) => MODEL_EFFORT_KEYS.includes(key) ? [] : groups.find((group) => group.key === key) ?? [])
}

/** Signals for the all-settings button: Plan mode and removed safeguards not already visible in chips. */
function useStatus({ groups, summary, pinned, narrow }: Pick<ComposerSettingsProps, 'groups' | 'summary' | 'pinned' | 'narrow'>) {
  const t = useTranslate()
  const visible = new Set([...MODEL_EFFORT_KEYS, ...(narrow ? [] : pinnedExtras(groups, pinned).map((group) => group.key))])
  const warnings = summary.filter((segment) => segment.tone === 'caution' && !visible.has(segment.key))
  const plan = groups.find((group) => (group.key === 'mode' || group.key === 'permission') && group.value === 'plan' && !visible.has(group.key))
  const statusLabels = [
    ...(plan ? [plan.options.find((option) => option.value === plan.value)?.label ?? plan.value] : []),
    ...warnings.map((segment) => {
      const group = groups.find((group) => group.key === segment.key)
      return group ? t('composer.settings.quick', { setting: group.label, value: segment.label }) : segment.label
    }),
  ]
  const summaryLabel = [
    ...summary.filter((segment) => segment.tone !== 'caution' && segment.key !== plan?.key && !visible.has(segment.key)).map((segment) => segment.label),
    ...statusLabels,
  ].join(' · ')
  return { statusLabels, summaryLabel, caution: warnings.length > 0 }
}

/** Full panel behind its desktop button or phone chip. */
function FullPanel({ groups, pinned, onPinnedChange, narrow, mcp, feedback, disabled, close }: ComposerSettingsProps & { close: (resumeTyping?: boolean) => void }) {
  return (
    <SettingsPanel groups={groups} pinned={pinned} onPinnedChange={narrow ? undefined : onPinnedChange} disabled={disabled}
      extra={mcp} feedback={feedback} onDone={() => close(true)} onClose={() => close()} />
  )
}

/**
 * Model/effort chip and desktop pins beside it. These settings are usually chosen together and
 * effort depends on model; combining saves room for additional settings.
 */
export function ComposerQuickSettings(props: ComposerSettingsProps) {
  const { groups, pinned, narrow, disabled = false, inputRef } = props
  const t = useTranslate()
  const model = groups.find((group) => group.key === 'model')
  const effort = groups.find((group) => group.key === 'effort')
  const extras = narrow ? [] : pinnedExtras(groups, pinned)
  const { statusLabels, caution } = useStatus(props)
  if (!model) return null

  const modelValue = valueLabel(model, t)
  const effortValue = effort ? valueLabel(effort, t) : null
  const label = t('composer.settings.quick', {
    setting: effort ? t('composer.settings.modelEffort') : model.label,
    value: [modelValue, effortValue].filter(Boolean).join(' · '),
  })

  const chip = (
    <TooltipButton type="button" disabled={disabled}
      aria-label={narrow && statusLabels.length > 0 ? [label, ...statusLabels].join(' · ') : label}
      title={narrow ? [label, ...statusLabels].join(' · ') : label}
      className={cx(chipClass(narrow), 'min-w-0 font-medium text-ink', narrow ? 'flex-initial' : 'shrink-0 max-w-80')}
    >
      {narrow ? null : <span className="shrink-0 text-accent">{model.icon}</span>}
      <span className="min-w-0 truncate text-left">
        {modelValue}{effortValue ? <span className="font-normal text-ink-soft"> · {effortValue}</span> : null}
      </span>
      {/* Phones lack separate settings buttons, so the chip carries their signal. */}
      {narrow && statusLabels.length > 0 ? <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', caution ? 'bg-caution' : 'bg-accent')} /> : null}
      <ChevronDown size={12} className="shrink-0 text-ink-faint" />
    </TooltipButton>
  )

  return (
    <>
      {narrow ? (
        <SettingsSurface label={t('composer.settings.title')} inputRef={inputRef} disabled={disabled} trigger={chip}>
          {(close) => <FullPanel {...props} close={close} />}
        </SettingsSurface>
      ) : (
        <SettingsSurface label={t('composer.settings.modelEffort')} inputRef={inputRef} disabled={disabled} quick trigger={chip}>
          {(close) => (
            <>
              <SettingsHeading title={effort ? t('composer.settings.modelEffort') : model.label} onClose={() => close()} />
              {/* Scroll models alone with effort fixed below; long catalogs otherwise push effort out of view. */}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                {model.notice ? <p className="mb-2 text-xs text-caution">{model.notice}</p> : null}
                {/* Model selection keeps menus open because effort levels just changed and are usually next. */}
                <SettingOptions group={model} disabled={disabled} dense onPick={model.onChange} />
              </div>
              {effort ? (
                <section aria-label={effort.label} className="shrink-0 border-t border-line p-3 pb-[max(0.75rem,var(--sg-safe-bottom))]">
                  <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-ink-soft">{effort.icon}{effort.label}</h3>
                  <SettingOptions group={effort} disabled={disabled} compact onPick={(value) => { effort.onChange(value); close(true) }} />
                </section>
              ) : <div aria-hidden className="shrink-0 pb-[var(--sg-safe-bottom)]" />}
            </>
          )}
        </SettingsSurface>
      )}
      {extras.map((group) => group.active !== undefined
        ? <ToggleIcon key={group.key} group={group} disabled={disabled} />
        : <ExtraChip key={group.key} group={group} disabled={disabled} inputRef={inputRef} />)}
    </>
  )
}

/** Full-panel button on desktop only. */
export function ComposerSettingsButton(props: ComposerSettingsProps) {
  const { disabled = false, inputRef } = props
  const t = useTranslate()
  const { statusLabels, summaryLabel, caution } = useStatus(props)
  return (
    <SettingsSurface
      label={t('composer.settings.title')}
      inputRef={inputRef}
      disabled={disabled}
      trigger={
        <TooltipButton type="button" disabled={disabled}
          aria-label={t('composer.settings.label', { summary: summaryLabel })}
          title={[t('composer.settings.all'), ...statusLabels].join(' · ')}
          className={cx(toolButtonClass(false), 'relative text-ink-soft data-[state=open]:bg-accent-wash')}
        >
          <SlidersHorizontal size={16} />
          {statusLabels.length > 0 ? <span aria-hidden className={cx('absolute right-1 top-1 size-1.5 rounded-full', caution ? 'bg-caution' : 'bg-accent')} /> : null}
        </TooltipButton>
      }
    >
      {(close) => <FullPanel {...props} close={close} />}
    </SettingsSurface>
  )
}

function valueLabel(group: SettingGroup, t: ReturnType<typeof useTranslate>): string {
  return group.options.find((option) => option.value === group.value)?.label || group.value || t('composer.select.default')
}

function chipClass(narrow: boolean): string {
  return cx(
    'flex items-center gap-1.5 rounded-md px-2 text-xs',
    'hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
    'data-[state=open]:bg-surface-high disabled:pointer-events-none disabled:opacity-45',
    narrow ? 'relative h-9 text-[0.8125rem] before:absolute before:inset-x-0 before:-inset-y-1 before:content-[""]' : 'min-h-11 md:min-h-8 pointer-coarse:min-h-11',
  )
}

/** Pinned multi-value category showing its value and menu. */
function ExtraChip({ group, disabled, inputRef }: { group: SettingGroup; disabled: boolean; inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const t = useTranslate()
  const current = group.options.find((option) => option.value === group.value)
  const value = valueLabel(group, t)
  const label = t('composer.settings.quick', { setting: group.label, value })
  const caution = current?.tone === 'caution'
  return (
    <SettingsSurface label={group.label} inputRef={inputRef} disabled={disabled} quick
      trigger={
        <TooltipButton type="button" disabled={disabled} aria-label={label} title={[label, group.notice].filter(Boolean).join(' · ')}
          className={cx(chipClass(false), 'max-w-60 shrink-0', caution ? 'text-caution' : 'text-ink-soft')}
        >
          <span className={cx('shrink-0', caution ? 'text-caution' : 'text-accent')}>{group.icon}</span>
          <span className="min-w-0 truncate text-left">{value}</span>
          <ChevronDown size={12} className="shrink-0 text-ink-faint" />
        </TooltipButton>
      }
    >
      {(close) => (
        <>
          <SettingsHeading title={group.label} onClose={() => close()} />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(0.75rem,var(--sg-safe-bottom))]">
            {group.notice ? <p className="mb-2 text-xs text-caution">{group.notice}</p> : null}
            <SettingOptions group={group} disabled={disabled} onPick={(value) => { group.onChange(value); close(true) }} />
          </div>
        </>
      )}
    </SettingsSurface>
  )
}

/**
 * Pinned two-state category as an icon colored when enabled. Click toggles; tooltip supplies name
 * and state.
 */
function ToggleIcon({ group, disabled }: { group: SettingGroup; disabled: boolean }) {
  const t = useTranslate()
  const checked = group.value === group.active
  const other = group.options.find((option) => option.value !== group.value && !option.disabled)
  const current = group.options.find((option) => option.value === group.value)
  const label = t('composer.settings.quick', { setting: group.label, value: valueLabel(group, t) })
  const caution = checked && current?.tone === 'caution'
  return (
    <TooltipButton type="button" role="switch" aria-checked={checked} disabled={disabled || !other}
      aria-label={label} title={[label, group.notice].filter(Boolean).join(' · ')}
      onClick={() => { if (other) group.onChange(other.value) }}
      className={cx(toolButtonClass(false), checked && (caution ? 'bg-caution/14 text-caution hover:bg-caution/20 hover:text-caution' : 'bg-accent-wash text-accent hover:bg-accent-wash hover:text-accent'))}
    >
      {group.icon}
    </TooltipButton>
  )
}

/** Same contents anchored on desktop or shown in a touch sheet. */
export function SettingsSurface({ label, trigger, children, inputRef, disabled, quick = false, spacious = false }: {
  label: string
  trigger: ReactNode
  children: (close: (resumeTyping?: boolean) => void) => ReactNode
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
  quick?: boolean
  spacious?: boolean
}) {
  const [open, setOpen] = useState(false)
  const sheet = useMediaQuery('(max-width: 34rem), (pointer: coarse)')
  const content = useRef<HTMLDivElement>(null)
  const wasTyping = useRef(false)
  const resumeTyping = useRef(false)

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const changeOpen = (next: boolean) => {
    if (next) resumeTyping.current = false
    setOpen(next)
  }
  const close = (resume = false) => {
    resumeTyping.current = resume && wasTyping.current
    setOpen(false)
  }
  const triggerEvents = {
    onPointerDown: () => { wasTyping.current = document.activeElement === inputRef.current },
    onKeyDown: () => { wasTyping.current = false },
  }
  const onOpenAutoFocus = (event: Event) => {
    event.preventDefault()
    // Do not focus phone search or it would open the keyboard.
    const target = quick
      ? content.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]:not(:disabled), [role="radio"][tabindex="0"]')
      : null
    const focus = target ?? content.current?.querySelector<HTMLElement>('[data-settings-heading]')
    focus?.focus({ preventScroll: true })
    // Reveal the current choice in long lists, scrolling only that list rather than the page.
    if (target) target.scrollIntoView({ block: 'nearest' })
  }
  const onCloseAutoFocus = (event: Event) => {
    // Radix returns focus to the trigger on phones and keyboard interaction.
    if (!sheet && resumeTyping.current && inputRef.current) {
      event.preventDefault()
      inputRef.current.focus({ preventScroll: true })
    }
  }

  return sheet || spacious ? (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild {...triggerEvents}>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content ref={content} aria-describedby={undefined} onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}
          className={cx('surface fixed z-50 flex flex-col overflow-hidden border-line shadow-pop',
            spacious && !sheet
              ? 'left-1/2 top-1/2 w-[min(860px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border'
              : 'inset-x-0 rounded-t-xl border-t')}
          style={{
            bottom: spacious && !sheet ? 'auto' : 'max(0px, calc(100dvh - var(--sg-app-height, 100dvh) - var(--sg-viewport-top, 0px)))',
            height: spacious ? 'min(78dvh, 680px)' : undefined,
            maxHeight: 'min(85dvh, calc(var(--sg-app-height, 100dvh) - 1rem))',
          }}
        >
          {sheet ? <div aria-hidden className="mx-auto mt-2 h-1 w-8 shrink-0 rounded-full bg-line-strong" /> : null}
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          {children(close)}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  ) : (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild {...triggerEvents}>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content ref={content} side="top" align={quick ? 'start' : 'end'} sideOffset={8} collisionPadding={12}
          aria-label={label} onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}
          className={cx('surface z-50 flex flex-col overflow-hidden rounded-xl border border-line shadow-pop outline-none', quick ? 'w-[min(23rem,var(--radix-popover-content-available-width))]' : 'w-[min(28rem,var(--radix-popover-content-available-width))]')}
          style={{ maxHeight: 'var(--radix-popover-content-available-height)' }}
        >
          {children(close)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
