import { Languages, Loader } from 'lucide-react'
import { LOCALES, LOCALE_LABELS, setLocale, useLocale, usePendingLocale } from '../lib/i18n'
import { cx } from './ui'

/**
 * Language choice for screens shown before Appearance settings are reachable (sign-in, first-run
 * tour): someone facing an interface in a language they do not read needs it immediately. Same
 * mechanism as settings, and like them it applies to this device only.
 */
export function LanguageSwitch({ compact = false, plain = false }: {
  compact?: boolean
  /** Without its frame, the current language underlined: for a page where it should not draw the eye. */
  plain?: boolean
}) {
  const active = useLocale()
  const pending = usePendingLocale()
  return (
    <div
      className={cx('inline-flex items-center gap-1', plain ? null : 'rounded-md border border-line bg-surface p-0.5')}
      role="group"
      aria-label="Language"
    >
      {compact ? null : <Languages size={14} className="ml-1.5 text-ink-faint" aria-hidden />}
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          // The code alone on a phone, where the full names crowd out the step title.
          aria-label={LOCALE_LABELS[option]}
          aria-pressed={active === option}
          aria-busy={pending === option}
          onClick={() => {
            setLocale(option).catch((error: unknown) => console.warn(error))
          }}
          className={cx(
            'inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium transition-colors',
            active !== option
              ? plain
                ? 'text-ink-faint hover:text-ink'
                : 'text-ink-soft hover:text-ink'
              : plain
                ? 'text-ink underline decoration-accent decoration-2 underline-offset-[5px]'
                : 'bg-accent-wash text-ink',
          )}
        >
          {pending === option ? <Loader size={12} className="animate-spin" aria-hidden /> : null}
          {compact ? option.toUpperCase() : LOCALE_LABELS[option]}
        </button>
      ))}
    </div>
  )
}
