import { ArrowLeft, ArrowRight, Check, Info, Languages, Lightbulb, Loader, X } from 'lucide-react'
import { useEffect, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react'
import type { CurrentUser, InstanceProfile, OnboardingAnswers, OnboardingState } from '@sillage/protocol'
import { LOCALES, LOCALE_LABELS, setLocale, useLocale, usePendingLocale, useTranslate } from '../../lib/i18n'
import type { OnboardingStepId } from '../../lib/onboarding'
import { Logo } from '../Logo'
import { Button, cx } from '../ui'

/**
 * Step contract for the page: whether Continue is available and what to do before advancing. The
 * page owns navigation buttons while steps own forms; account-creation steps know when passwords
 * are too short to continue.
 */
export interface StepGate {
  canContinue?: boolean
  laterAllowed?: boolean
  skipAllowed?: boolean
}

export interface StepNav {
  commit: MutableRefObject<(() => Promise<void>) | null>
  setGate: (gate: StepGate) => void
}

export interface StepProps {
  nav: StepNav
  state: OnboardingState
  /** Save part of the state immediately. */
  update: (patch: Partial<OnboardingState>) => void
  setAnswers: (patch: Partial<OnboardingAnswers>) => void
  profile: InstanceProfile
  /** Null until the first account is created. */
  user: CurrentUser | null
  hostname: string
  homeDir: string
}

/** Action executed before Continue, refreshed each render to read current fields. */
export function useCommit(nav: StepNav, fn: (() => Promise<void>) | null): void {
  useEffect(() => {
    nav.commit.current = fn
    return () => {
      nav.commit.current = null
    }
  })
}

export function useGate(nav: StepNav, gate: StepGate): void {
  const { canContinue, laterAllowed, skipAllowed } = gate
  const { setGate } = nav
  useEffect(() => {
    setGate({ canContinue, laterAllowed, skipAllowed })
  }, [setGate, canContinue, laterAllowed, skipAllowed])
}

/** Why callout uses a straight left rule like other edge markers. */
export function Why({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 border-l-[3px] border-accent bg-accent-wash/40 px-4 py-3 text-sm leading-relaxed text-ink-soft">
      <Lightbulb size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 [&_b]:font-semibold [&_b]:text-ink">{children}</div>
    </div>
  )
}

export function Tip({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 text-xs leading-relaxed text-ink-faint">
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

export function StepTitle({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {lead ? <p className="text-[0.9375rem] leading-relaxed text-ink-soft">{lead}</p> : null}
    </header>
  )
}

export function Question({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-ink">
        {label}
        {hint ? <span className="ml-2 text-xs font-normal text-ink-faint">{hint}</span> : null}
      </h2>
      {children}
    </section>
  )
}

/**
 * Card choice with icon, label, explanation, and selected checkmark. multi makes it a checkbox
 * rather than radio.
 */
export function ChoiceCard({
  selected,
  onClick,
  icon,
  label,
  hint,
  multi = false,
  compact = false,
}: {
  selected: boolean
  onClick: () => void
  icon?: ReactNode
  label: string
  hint?: string
  multi?: boolean
  compact?: boolean
}) {
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        'flex min-w-0 items-start gap-2.5 rounded-lg border text-left transition-colors',
        compact ? 'min-h-11 items-center px-3 py-2' : 'px-3 py-2.5',
        selected ? 'border-accent bg-accent-wash' : 'border-line bg-surface hover:border-line-strong',
      )}
    >
      {icon ? (
        <span className={cx('grid size-7 shrink-0 place-items-center rounded-md bg-surface-high', selected ? 'text-accent' : 'text-ink-soft')}>
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs leading-snug text-ink-faint">{hint}</span> : null}
      </span>
      <Check size={16} className={cx('mt-0.5 shrink-0 text-accent', selected ? 'opacity-100' : 'opacity-0')} aria-hidden />
    </button>
  )
}

export function CardGrid({ columns = 2, children }: { columns?: 1 | 2 | 3; children: ReactNode }) {
  return (
    <div className={cx('grid gap-2', columns === 3 ? 'sm:grid-cols-3' : columns === 2 ? 'sm:grid-cols-2' : '')}>
      {children}
    </div>
  )
}

/**
 * Language accessible from the first screen: users need it immediately when the interface speaks
 * another language, before Appearance settings are reachable. Same mechanism as settings.
 */
function LanguageSwitch() {
  const active = useLocale()
  const pending = usePendingLocale()
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-line bg-surface p-0.5" role="group" aria-label="Language">
      <Languages size={14} className="ml-1.5 text-ink-faint" aria-hidden />
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          aria-pressed={active === option}
          aria-busy={pending === option}
          onClick={() => {
            setLocale(option).catch((error: unknown) => console.warn(error))
          }}
          className={cx(
            'inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium transition-colors',
            active === option ? 'bg-accent-wash text-ink' : 'text-ink-soft hover:text-ink',
          )}
        >
          {pending === option ? <Loader size={12} className="animate-spin" aria-hidden /> : null}
          {LOCALE_LABELS[option]}
        </button>
      ))}
    </div>
  )
}

export interface ShellStep {
  id: OnboardingStepId
  title: string
  sub: string
  status: 'done' | 'skipped' | 'current' | 'todo'
  /** Clickable backward or forward to previously visited steps. */
  reachable: boolean
}

/**
 * Tour frame: steps on the left for desktop, top progress on phones, bottom buttons. Fullscreen
 * without app navigation to keep attention here.
 */
export function OnboardingShell({
  steps,
  index,
  onGoto,
  onSkipAll,
  onBack,
  onNext,
  onLater,
  nextLabel,
  pending,
  canContinue,
  laterAllowed,
  skipAllowed,
  error,
  children,
}: {
  steps: ShellStep[]
  index: number
  onGoto: (index: number) => void
  onSkipAll: () => void
  onBack: () => void
  onNext: () => void
  onLater: () => void
  nextLabel: string
  pending: boolean
  canContinue: boolean
  laterAllowed: boolean
  skipAllowed: boolean
  error: string | null
  children: ReactNode
}) {
  const t = useTranslate()
  const current = steps[index]
  const first = index === 0
  const last = index === steps.length - 1

  /*
   * Enter in an input activates the step action like a form. Steps cannot be forms because embedded
   * project/account forms cannot nest. Inputs within embedded forms retain their own submit
   * actions. Textareas preserve Enter newlines and submit with Ctrl/Cmd+Enter.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    const target = event.target
    const textarea = target instanceof HTMLTextAreaElement
    if (!textarea && !(target instanceof HTMLInputElement)) return
    if (textarea && !(event.metaKey || event.ctrlKey)) return
    if (target instanceof HTMLInputElement && ['checkbox', 'radio', 'range', 'button', 'submit'].includes(target.type)) return
    if (target.closest('form')) return
    event.preventDefault()
    if (canContinue && !pending) onNext()
  }

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink md:grid md:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="hidden min-h-0 flex-col gap-5 overflow-y-auto border-r border-line bg-surface p-5 md:flex">
        <div className="flex items-center gap-3">
          <span className="gradient-accent shadow-float grid size-9 place-items-center rounded-xl">
            <Logo size={20} className="text-accent-ink" />
          </span>
          <span>
            <span className="block text-sm font-semibold">Sillage</span>
            <span className="block text-xs text-ink-faint">{t('onboarding.shell.subtitle')}</span>
          </span>
        </div>
        <ol className="flex flex-col gap-0.5">
          {steps.map((step, i) => (
            <li key={step.id}>
              <button
                type="button"
                // Do not jump into unknown steps that may depend on current answers.
                disabled={!step.reachable || i === index}
                aria-current={step.status === 'current' ? 'step' : undefined}
                onClick={() => onGoto(i)}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-default',
                  step.status === 'current' ? 'bg-accent-wash text-ink' : step.status === 'todo' ? 'text-ink-faint' : 'text-ink-soft hover:bg-surface-high',
                )}
              >
                <span
                  className={cx(
                    'grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold',
                    step.status === 'done'
                      ? 'border-positive bg-positive text-accent-ink'
                      : step.status === 'current'
                        ? 'border-accent text-accent'
                        : step.status === 'skipped'
                          ? 'border-dashed border-line-strong'
                          : 'border-line-strong',
                  )}
                >
                  {step.status === 'done' ? <Check size={13} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate">{step.title}</span>
                  <span className="block truncate text-xs text-ink-faint">{step.status === 'skipped' ? t('onboarding.shell.skipped') : step.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <p className="mt-auto text-xs leading-relaxed text-ink-faint">{t('onboarding.shell.foot')}</p>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Phone layout: named step and progress at top. */}
        {/* Add safe-area padding to block spacing: pt-safe alone replaces it and is zero off phones. */}
        <div className="flex shrink-0 flex-col gap-2 px-4 md:hidden" style={{ paddingTop: 'calc(0.75rem + var(--sg-safe-top))' }}>
          <div className="flex items-center gap-2">
            <span className="gradient-accent grid size-7 place-items-center rounded-lg">
              <Logo size={15} className="text-accent-ink" />
            </span>
            <span className="text-sm font-semibold">{t('onboarding.shell.subtitle')}</span>
            <span className="ml-auto flex items-center gap-2">
              <LanguageSwitch />
              {skipAllowed ? (
                <button type="button" onClick={onSkipAll} className="text-sm text-ink-faint">
                  {t('onboarding.shell.skip.short')}
                </button>
              ) : null}
            </span>
          </div>
          <div className="flex gap-1" aria-hidden>
            {steps.map((step, i) => (
              <i key={step.id} className={cx('block h-0.5 flex-1 rounded-full', i <= index ? 'bg-accent' : 'bg-line')} />
            ))}
          </div>
          <p className="text-xs text-ink-faint">
            {t('onboarding.shell.progress', { step: index + 1, total: steps.length, title: current?.title ?? '' })}
          </p>
        </div>

        <div className="hidden shrink-0 px-6 pt-3 md:block">
          <div className="flex w-full items-center justify-end gap-3">
            <LanguageSwitch />
            {skipAllowed ? (
              <Button variant="ghost" size="sm" onClick={onSkipAll} icon={<X size={14} />}>
                {t('onboarding.shell.skip')}
              </Button>
            ) : null}
          </div>
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-14 md:py-2" onKeyDown={onKeyDown}>
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 pb-6">{children}</div>
        </main>

        <footer className="shrink-0 border-t border-line bg-surface px-4 pt-3 md:px-14" style={{ paddingBottom: 'calc(0.75rem + var(--sg-safe-bottom))' }}>
          {/* Full-width buttons at corners, where users expect them. */}
          <div className="flex w-full items-center gap-2">
            {first ? null : (
              <Button variant="secondary" onClick={onBack} disabled={pending} icon={<ArrowLeft size={15} />}>
                <span className="hidden sm:inline">{t('onboarding.shell.back')}</span>
              </Button>
            )}
            {error ? <span className="min-w-0 truncate text-xs text-critical">{error}</span> : null}
            <span className="flex-1" />
            {laterAllowed && !last ? (
              <Button variant="ghost" onClick={onLater} disabled={pending}>
                {t('onboarding.shell.later')}
              </Button>
            ) : null}
            <Button onClick={onNext} disabled={pending || !canContinue} icon={last ? undefined : <ArrowRight size={15} />}>
              {nextLabel}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}
