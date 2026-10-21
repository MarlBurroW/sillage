import { Check } from 'lucide-react'
import { useTranslate } from '../lib/i18n'
import { TYPING_INDICATORS, TYPING_INDICATOR_LABELS, useTypingIndicator } from '../lib/typing-indicator'
import { TypingIndicator } from './chat/TypingIndicator'
import { TurnActivity } from './chat/TurnActivity'
import { cx } from './ui'

export function TypingIndicatorControls() {
  const [selected, setSelected] = useTypingIndicator()
  const t = useTranslate()

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label={t('settings.typingIndicator.title')}>
        {TYPING_INDICATORS.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={t(TYPING_INDICATOR_LABELS[option])}
            aria-pressed={selected === option}
            onClick={() => setSelected(option)}
            className={cx(
              'relative flex min-w-0 flex-col items-center gap-2 rounded-md border px-2.5 py-3',
              selected === option
                ? 'border-accent bg-accent-wash text-ink'
                : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
            )}
          >
            <Check size={13} aria-hidden className={cx('absolute top-2 right-2 text-accent', selected !== option && 'invisible')} />
            <TypingIndicator variant={option} size={30} />
            <span className="text-xs font-medium">{t(TYPING_INDICATOR_LABELS[option])}</span>
            {option === 'sillage' ? <span className="text-[0.625rem] text-ink-faint">{t('typingIndicator.default')}</span> : null}
          </button>
        ))}
      </div>
      <div className="rounded-md border border-line bg-canvas px-3 py-2.5">
        <p className="mb-1 text-xs text-ink-faint">{t('typingIndicator.preview')}</p>
        <TurnActivity label={t('activity.writing')} />
      </div>
    </div>
  )
}
