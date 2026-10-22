import { TooltipButton } from '../ui/Tooltip'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Turn navigation. Desktop rails require space and targeting two-pixel markers, unusable on touch.
 * Arrows cover the same need everywhere and support desktop keyboards. Callers place them above the
 * variable-height composer rather than mid-thread where they obscured messages.
 */
export function TurnNav({ count, onStep }: { count: number; onStep: (direction: -1 | 1) => void }) {
  const t = useTranslate()
  // A lone turn needs no navigation.
  if (count < 2) return null

  return (
    <div
      className={cx(
        'surface flex flex-col overflow-hidden rounded-full border border-line shadow-float',
      )}
    >
      <TooltipButton
        type="button"
        onClick={() => onStep(-1)}
        aria-label={t('turn.nav.previous')}
        title={t('turn.nav.previous')}
        className="flex size-9 items-center justify-center text-ink-faint transition-colors hover:bg-surface-high hover:text-ink"
      >
        <ChevronUp size={16} />
      </TooltipButton>
      <span aria-hidden className="h-px bg-line" />
      <TooltipButton
        type="button"
        onClick={() => onStep(1)}
        aria-label={t('turn.nav.next')}
        title={t('turn.nav.next')}
        className="flex size-9 items-center justify-center text-ink-faint transition-colors hover:bg-surface-high hover:text-ink"
      >
        <ChevronDown size={16} />
      </TooltipButton>
    </div>
  )
}
