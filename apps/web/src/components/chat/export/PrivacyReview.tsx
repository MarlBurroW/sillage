import * as Dialog from '@radix-ui/react-dialog'
import { Plus, Scissors, X, ExternalLink } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { ExportField, ExportFinding, ExportRenderRequest } from '@sillage/protocol'
import { exportImageUrl } from '../../../lib/conversation-export'
import { maskedExcerpt, phraseMasks } from '../../../lib/export-review'
import { useTranslate } from '../../../lib/i18n'
import { Button, Field, IconButton, cx } from '../../ui'
import { CheckField, ExportTabs, textareaClass } from './controls'
import { ImageViewer } from '../ImageViewer'
type Manual = ExportRenderRequest['manual']

export function PrivacyReview({ draftId, fields, findings, kept, setKept, manual, setManual, images, reviewed, setReviewed, tab, setTab }: {
  draftId: string; fields: ExportField[]; findings: ExportFinding[]; kept: string[]; setKept: (ids: string[]) => void;
  manual: Manual; setManual: (value: Manual) => void; images: { id: string; label: string }[]; reviewed: string[]; setReviewed: (ids: string[]) => void;
  tab: 'detected' | 'text' | 'images'; setTab: (tab: 'detected' | 'text' | 'images') => void;
}) {
  const t = useTranslate()
  const [visible, setVisible] = useState(30)
  const [addingPhrase, setAddingPhrase] = useState(false)
  const [viewImage, setViewImage] = useState<number | null>(null)
  const byField = useMemo(() => {
    const result = new Map<string, ExportFinding[]>()
    for (const finding of findings) {
      const group = result.get(finding.fieldId) ?? []
      group.push(finding); result.set(finding.fieldId, group)
    }
    return result
  }, [findings])
  const entries = [...new Set(fields.map(field => field.entryId).filter(Boolean))]
  const shown = fields.filter(field => field.text.trim() && (tab === 'text' || byField.has(field.id)))
  const toggleGroup = (finding: ExportFinding) => {
    const ids = findings.filter(other => other.group === finding.group).map(other => other.id)
    setKept(kept.includes(finding.id) ? kept.filter(id => !ids.includes(id)) : [...new Set([...kept, ...ids])])
  }
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
    <div className="mx-auto max-w-3xl">
      <p className="mb-3 text-sm leading-relaxed text-ink-soft">{t('export.privacy.hint')}</p>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink-soft" role="status">{t('export.privacy.summary', { masked: findings.length - kept.length, kept: kept.length, manual: manual.length })}</p>
        <Button size="sm" variant="secondary" icon={<Plus size={15} />} onClick={() => setAddingPhrase(true)}>{t('export.privacy.addPhrase')}</Button>
      </div>
      <ExportTabs id="export-review" label={t('export.step.privacy')} value={tab} onChange={value => { setTab(value); setVisible(30) }}
        tabs={[{ value: 'detected', label: t('export.privacy.detectedTab', { count: findings.length }) }, { value: 'text', label: t('export.privacy.textTab') },
          ...(images.length ? [{ value: 'images' as const, label: t('export.privacy.imagesTab', { count: images.length }) }] : [])]} />
      <div id="export-review-panel" role="tabpanel" aria-labelledby={'export-review-' + tab}>
      {tab !== 'images' && <>
      {tab === 'detected' && !findings.length && <p className="py-8 text-sm text-ink-soft">{t('export.privacy.none')}</p>}
      <div className="divide-y divide-line">
        {shown.slice(0, visible).map(field => <div key={field.id} data-export-field={field.id} className="py-4">
          <h3 className="mb-1 text-xs font-semibold text-ink-faint">{field.entryId ? t('export.privacy.entry', { number: entries.indexOf(field.entryId) + 1, kind: t(('export.field.' + field.kind) as 'export.field.message') }) : t(('export.field.' + field.kind) as 'export.field.message')}</h3>
          <p className="mb-3 line-clamp-2 break-words text-sm text-ink-soft">{maskedExcerpt(field, byField.get(field.id) ?? [], manual, t('export.page.mask.manual'))}</p>
          {(byField.get(field.id) ?? []).map(finding => <Finding key={finding.id} field={field} finding={finding} findings={byField.get(field.id) ?? []}
            kept={kept.includes(finding.id)} toggle={() => setKept(kept.includes(finding.id) ? kept.filter(id => id !== finding.id) : [...kept, finding.id])}
            groupCount={findings.filter(other => other.group === finding.group).length} toggleGroup={() => toggleGroup(finding)} />)}
          <ManualRedaction field={field} manual={manual} setManual={setManual} />
        </div>)}
      </div>
      {visible < shown.length && <Button variant="secondary" onClick={() => setVisible(value => value + 30)}>{t('export.loadMore')}</Button>}
      </>}
      {tab === 'images' && <div className="pt-4">
        <p className="mb-4 text-xs text-ink-faint">{t('export.images.hint')}</p>
        {images.map((image, index) => <figure key={image.id} className="mb-6">
          <img src={exportImageUrl(draftId, image.id)} alt={image.label} className="max-h-96 max-w-full rounded border border-line object-contain" />
          <Button variant="ghost" size="sm" icon={<ExternalLink size={14} />} onClick={() => setViewImage(index)}>{t('export.images.open')}</Button>
          <CheckField checked={reviewed.includes(image.id)} onChange={checked => setReviewed(checked ? [...reviewed, image.id] : reviewed.filter(id => id !== image.id))}>{t('export.images.reviewed')}</CheckField>
        </figure>)}
      </div>}
      </div>
      {addingPhrase && <PhraseDialog fields={fields} manual={manual} setManual={setManual} onClose={() => setAddingPhrase(false)} />}
      {viewImage !== null && <ImageViewer images={images.map(image => ({ src: exportImageUrl(draftId, image.id), alt: image.label }))} initialIndex={viewImage} onClose={() => setViewImage(null)} />}
    </div>
  </div>
}

function Finding({ field, finding, findings, kept, toggle, toggleGroup, groupCount }: { field: ExportField; finding: ExportFinding; findings: ExportFinding[]; kept: boolean; toggle: () => void; toggleGroup: () => void; groupCount: number }) {
  const t = useTranslate()
  const [reveal, setReveal] = useState(false)
  const context = (start: number, end: number) => {
    let cursor = start, text = ''
    for (const other of findings.filter(other => other.start < end && other.end > start).sort((a, b) => a.start - b.start)) {
      if (other.end <= cursor) continue
      text += field.text.slice(cursor, Math.max(cursor, other.start)) + t(('export.page.mask.' + other.kind) as 'export.page.mask.secret')
      cursor = Math.min(end, other.end)
    }
    return text + field.text.slice(cursor, end)
  }
  return <div data-export-finding={finding.kind} className="mb-3 border-l-2 border-accent/50 bg-sunken p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-medium text-ink-soft">{t(('export.kind.' + finding.kind) as 'export.kind.secret')}</span>
      <div className="flex items-center gap-3">
        <CheckField checked={!kept} onChange={toggle}>{t('export.privacy.mask')}</CheckField>
        <button className="min-h-8 text-xs text-accent hover:underline" onClick={() => setReveal(!reveal)}>{t(reveal ? 'export.privacy.hide' : 'export.privacy.reveal')}</button>
      </div>
    </div>
    {kept && <p className="mb-2 text-xs font-semibold text-ink">{t('export.privacy.visible')}</p>}
    <p className="break-words font-mono text-xs leading-relaxed text-ink-soft">
      {context(Math.max(0, finding.start - 55), finding.start)}
      <mark className="bg-accent/15 px-1 text-ink">{reveal || kept ? field.text.slice(finding.start, finding.end) : t(('export.page.mask.' + finding.kind) as 'export.page.mask.secret')}</mark>
      {context(finding.end, Math.min(field.text.length, finding.end + 55))}
    </p>
    {groupCount > 1 && <div className="mt-2 flex flex-wrap items-center gap-x-3 text-xs">
      <span className="text-ink-faint">{t('export.privacy.groupCount', { count: groupCount })}</span>
      <button className="min-h-11 text-accent hover:underline" onClick={toggleGroup}>{t(kept ? 'export.privacy.maskAll' : 'export.privacy.keepAll')}</button>
    </div>}
  </div>
}

function ManualRedaction({ field, manual, setManual }: { field: ExportField; manual: Manual; setManual: (value: Manual) => void }) {
  const t = useTranslate()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [open, setOpen] = useState(false)
  const selected = manual.filter(mask => mask.fieldId === field.id)
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="text-sm">
    <summary className="min-h-9 cursor-pointer text-ink-soft">{t('export.privacy.showText')}{selected.length ? ' (' + selected.length + ')' : ''}</summary>
    {open && <div className="space-y-2 pt-2">
      <p className="text-xs text-ink-faint">{t('export.privacy.manual')}</p>
      <textarea ref={textarea} readOnly value={field.text} aria-label={t('export.privacy.original')} className={cx(textareaClass, 'min-h-44 font-mono text-xs')}
        onSelect={() => setSelection({ start: textarea.current?.selectionStart ?? 0, end: textarea.current?.selectionEnd ?? 0 })} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Scissors size={14} />} disabled={selection.end <= selection.start}
          onClick={() => {
            if (!selected.some(mask => mask.start === selection.start && mask.end === selection.end)) setManual([...manual, { fieldId: field.id, ...selection }])
          }}>{t('export.privacy.add')}</Button>
        {selected.length > 0 && <Button size="sm" variant="ghost" onClick={() => setManual(manual.filter(mask => mask.fieldId !== field.id))}>{t('export.privacy.clear')}</Button>}
      </div>
      {selected.map((mask, index) => <div key={index} className="flex items-center gap-2 text-xs text-ink-faint">
        <span>{t('export.page.mask.manual')} ({mask.end - mask.start})</span><IconButton size="sm" label={t('export.privacy.remove')}
          onClick={() => setManual(manual.filter(value => value !== mask))}><X size={13} /></IconButton>
      </div>)}
    </div>}
  </details>
}

function PhraseDialog({ fields, manual, setManual, onClose }: { fields: ExportField[]; manual: Manual; setManual: (value: Manual) => void; onClose: () => void }) {
  const t = useTranslate()
  const [phrase, setPhrase] = useState('')
  const matches = useMemo(() => phraseMasks(fields, phrase, manual), [fields, phrase, manual])
  const tooMany = matches.length + manual.length > 10_000
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content className="surface fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[min(30rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-line p-5 shadow-pop">
        <Dialog.Title className="font-semibold">{t('export.privacy.addPhrase')}</Dialog.Title>
        <Dialog.Description className="text-sm leading-relaxed text-ink-soft">{t('export.privacy.phraseHint')}</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); if (matches.length && !tooMany) { setManual([...manual, ...matches]); onClose() } }} className="flex flex-col gap-3">
          <Field label={t('export.privacy.phrase')} value={phrase} maxLength={5000} onChange={event => setPhrase(event.target.value)} autoComplete="off" />
          <p role="status" className="text-xs text-ink-faint">{t(tooMany ? 'export.privacy.tooMany' : 'export.privacy.matches', { count: matches.length })}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('export.cancel')}</Button>
            <Button type="submit" disabled={!matches.length || tooMany}>{t('export.privacy.applyPhrase')}</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
