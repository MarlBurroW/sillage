import { Eye, Pencil } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import { Markdown } from '../chat/Markdown'
import { cx } from '../ui'

/** Champs partagés par la création et l'édition, avec un aperçu qui conserve la saisie. */
export function CardEditor({ title, description, onChange, disabled = false }: {
  title: string
  description: string
  onChange: (value: { title: string; description: string }) => void
  disabled?: boolean
}) {
  const t = useTranslate()
  const descriptionId = useId()
  const [preview, setPreview] = useState(false)
  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-2 text-sm font-medium text-ink-soft">
        {t('board.card.title')}
        <textarea rows={2} maxLength={200} value={title} disabled={disabled}
          placeholder={t('board.card.new.placeholder')}
          onChange={(event) => onChange({ title: event.target.value, description })}
          className="min-h-20 w-full resize-y rounded-xl border border-line bg-sunken px-4 py-3 text-lg font-semibold leading-snug text-ink outline-none placeholder:font-normal placeholder:text-ink-faint focus:border-accent" />
      </label>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={descriptionId} className="text-sm font-medium text-ink-soft">{t('board.card.description')}</label>
          <div className="flex gap-1 rounded-lg bg-sunken p-1">
            {[false, true].map((value) => <button key={String(value)} type="button" aria-pressed={preview === value}
              onClick={() => setPreview(value)} className={cx('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs', preview === value ? 'surface text-ink shadow-sm' : 'text-ink-faint hover:text-ink')}>
              {value ? <Eye size={13} /> : <Pencil size={13} />}{t(value ? 'board.editor.preview' : 'board.editor.write')}
            </button>)}
          </div>
        </div>
        {preview ? <div className="min-h-56 rounded-xl border border-line px-4 py-3 text-sm"><Markdown text={description || t('board.editor.emptyPreview')} /></div> :
          <textarea id={descriptionId} value={description} disabled={disabled} rows={10} maxLength={20000}
            placeholder={t('board.editor.placeholder')}
            onChange={(event) => onChange({ title, description: event.target.value })}
            className="min-h-56 w-full resize-y rounded-xl border border-line bg-sunken px-4 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-accent" />}
        <p className="text-xs text-ink-faint">{t('board.editor.hint')}</p>
      </div>
    </div>
  )
}
