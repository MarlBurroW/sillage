import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslate } from '../../lib/i18n'
import { useMediaQuery } from '../../lib/viewport'
import { cx } from '../ui'
import { SettingOptions, SettingsHeading, SettingsPanel } from './SettingsPanel'

/**
 * Marque une valeur qui retire un garde-fou. Absente quand il n'y a rien à signaler :
 * un ton « neutre » explicite ne servirait qu'à nommer l'absence de signal.
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

/** Option dont la valeur reste dans son union d'origine, avant l'élargissement. */
export type SettingChoice<V extends string> = Omit<SettingOption, 'value'> & { value: V }

/** Les choix viennent du CLI ; leur disposition appartient au composer. */
export interface SettingGroup {
  key: string
  label: string
  icon?: ReactNode
  options: SettingOption[]
  value: string
  onChange: (value: string) => void
  /**
   * Ce qui sépare la valeur choisie de celle qui s'applique, quand le CLI ne sait pas
   * la changer sans repartir. Absent le reste du temps, c'est-à-dire presque toujours.
   */
  notice?: string
}

/**
 * Fabrique une catégorie sans perdre le type de la valeur.
 *
 * Le tableau des catégories est hétérogène, donc large sur `string`, et un
 * `SettingGroup<'a'|'b'>` ne s'y assigne pas puisque `onChange` est contravariant.
 * Cette fonction est l'unique point où l'on redescend vers l'union du protocole, et
 * elle vérifie que la valeur vient bien de la liste avant de le faire.
 */
export function setting<V extends string>(group: {
  key: string
  label: string
  icon?: ReactNode
  options: SettingChoice<V>[]
  value: V
  onChange: (value: V) => void
  notice?: string
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

interface ComposerSettingsProps {
  groups: SettingGroup[]
  summary: SummarySegment[]
  mcp?: ReactNode
  feedback?: ReactNode
  disabled?: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
}

export function ComposerSettings({ groups, summary, mcp, feedback, disabled = false, inputRef }: ComposerSettingsProps) {
  const t = useTranslate()
  const quick = ['model', 'effort'].flatMap((key) => groups.find((group) => group.key === key) ?? [])
  const warnings = summary.filter((segment) => segment.tone === 'caution')
  const plan = groups.find((group) => (group.key === 'mode' || group.key === 'permission') && group.value === 'plan')
  const statusLabels = [
    ...(plan ? [plan.options.find((option) => option.value === plan.value)?.label ?? plan.value] : []),
    ...warnings.map((segment) => {
      const group = groups.find((group) => group.key === segment.key)
      return group ? t('composer.settings.quick', { setting: group.label, value: segment.label }) : segment.label
    }),
  ]
  const summaryLabel = [
    ...summary.filter((segment) => segment.tone !== 'caution' && segment.key !== plan?.key).map((segment) => segment.label),
    ...statusLabels,
  ].join(' · ')

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        {quick.map((group) => {
          const value = group.options.find((option) => option.value === group.value)?.label || group.value || t('composer.select.default')
          const label = t('composer.settings.quick', { setting: group.label, value })
          return (
            <SettingsSurface
              key={group.key}
              label={group.label}
              inputRef={inputRef}
              disabled={disabled}
              quick
              trigger={
                <button type="button" disabled={disabled} aria-label={label} title={label}
                  className={cx(
                    'flex min-h-11 min-w-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs @min-[34rem]:max-w-80 @min-[34rem]:flex-initial',
                    'hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                    'data-[state=open]:border-accent/50 data-[state=open]:bg-accent-wash disabled:pointer-events-none disabled:opacity-45',
                    group.key === 'model' ? 'flex-[1.3] font-medium text-ink' : 'flex-1 text-ink-soft',
                  )}
                >
                  <span className="hidden shrink-0 text-accent @min-[22rem]:inline-flex">{group.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-left">{value}</span>
                  <ChevronDown size={12} className="shrink-0 text-ink-faint" />
                </button>
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
        })}
        <SettingsSurface
          label={t('composer.settings.title')}
          inputRef={inputRef}
          disabled={disabled}
          trigger={
            <button type="button" disabled={disabled}
              aria-label={t('composer.settings.label', { summary: summaryLabel })}
              title={[t('composer.settings.all'), ...statusLabels].join(' · ')}
              className="relative ml-auto flex size-11 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:bg-accent-wash disabled:pointer-events-none disabled:opacity-45"
            >
              <SlidersHorizontal size={16} />
              {statusLabels.length > 0 ? <span aria-hidden className={cx('absolute right-2 top-2 size-1.5 rounded-full', warnings.length > 0 ? 'bg-caution' : 'bg-accent')} /> : null}
            </button>
          }
        >
          {(close) => <SettingsPanel groups={groups} disabled={disabled} extra={mcp} feedback={feedback} onDone={() => close(true)} onClose={() => close()} />}
        </SettingsSurface>
      </div>
    </div>
  )
}

/** Même contenu, ancré sur ordinateur et dans une feuille sur écran tactile. */
export function SettingsSurface({ label, trigger, children, inputRef, disabled, quick = false }: {
  label: string
  trigger: ReactNode
  children: (close: (resumeTyping?: boolean) => void) => ReactNode
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
  quick?: boolean
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
    // Ne pas focaliser la recherche sur téléphone : cela ferait monter le clavier.
    const target = quick
      ? content.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]:not(:disabled), [role="radio"][tabindex="0"]')
      : null
    const focus = target ?? content.current?.querySelector<HTMLElement>('[data-settings-heading]')
    focus?.focus({ preventScroll: true })
  }
  const onCloseAutoFocus = (event: Event) => {
    // Sur téléphone et au clavier, Radix rend le focus au bouton d'ouverture.
    if (!sheet && resumeTyping.current && inputRef.current) {
      event.preventDefault()
      inputRef.current.focus({ preventScroll: true })
    }
  }

  return sheet ? (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild {...triggerEvents}>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content ref={content} aria-describedby={undefined} onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}
          className="surface fixed inset-x-0 z-50 flex flex-col overflow-hidden rounded-t-xl border-t border-line shadow-pop"
          style={{
            bottom: 'max(0px, calc(100dvh - var(--sg-app-height, 100dvh) - var(--sg-viewport-top, 0px)))',
            maxHeight: 'min(85dvh, calc(var(--sg-app-height, 100dvh) - 1rem))',
          }}
        >
          <div aria-hidden className="mx-auto mt-2 h-1 w-8 shrink-0 rounded-full bg-line-strong" />
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
