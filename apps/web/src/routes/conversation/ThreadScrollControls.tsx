import { ArrowDown } from 'lucide-react'
import { TurnNav } from '../../components/chat/TurnNav'
import { TooltipButton } from '../../components/ui/Tooltip'
import { cx } from '../../components/ui'
import { useTranslate } from '../../lib/i18n'

/** Back-to-bottom button and previous/next turn arrows, shown above the composer. */
export function ThreadScrollControls({
  onBottom,
  turnCount,
  onStep,
  concentration,
}: {
  onBottom: () => void
  turnCount: number
  onStep: (direction: -1 | 1) => void
  concentration: boolean
}) {
  const t = useTranslate()

  return (
    <>
      <TooltipButton
        type="button"
        onClick={onBottom}
        className={cx(
          'absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2',
          'surface rounded-full border border-line p-2 text-ink-soft shadow-float',
        )}
        aria-label={t('conversation.scroll.bottom')}
      >
        <ArrowDown size={16} />
      </TooltipButton>

      <div className={cx("absolute right-3 bottom-full z-10 mb-2", concentration && "hidden")}>
        <TurnNav count={turnCount} onStep={onStep} />
      </div>
    </>
  )
}
