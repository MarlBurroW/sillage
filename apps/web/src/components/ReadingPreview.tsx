import { useTranslate } from '../lib/i18n'
import { Markdown } from './chat/Markdown'

/**
 * Mock conversation for judging reading settings in place. Sliders affect html so this follows
 * automatically, reusing actual thread components and bubbles rather than drifting imitations. Text
 * exercises paragraphs, bold, inline code, and lists to reveal real size/line-height effects.
 */
export function ReadingPreview() {
  const t = useTranslate()

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3">
      <div className="flex justify-end">
        <div className="sg-user-bubble flex min-w-0 max-w-[85%] flex-col gap-2 rounded-lg rounded-br-sm border px-3.5 py-2.5 shadow-card">
          <Markdown text={t('readingPreview.question')} />
        </div>
      </div>
      <Markdown text={t('readingPreview.answer')} />
    </div>
  )
}
