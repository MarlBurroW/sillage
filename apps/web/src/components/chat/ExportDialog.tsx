import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronLeft, Copy, Download, Eye, Link2, LoaderCircle, Maximize2, Share2, ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConversationDto, ConversationShareDto, ExportDraftDto, ExportOptions, ExportRenderRequest, ExportSelectionDto } from '@sillage/protocol'
import { useConversationExport, exportUrl } from '../../lib/conversation-export'
import { reconcileReview } from '../../lib/export-review'
import { api } from '../../lib/api'
import { useTranslate } from '../../lib/i18n'
import { useCapability } from '../../lib/instance'
import { useCopy } from '../../lib/clipboard'
import { Banner, Button, Field, IconButton, Select, cx } from '../ui'
import { ContentSelection } from './export/ContentSelection'
import { PrivacyReview } from './export/PrivacyReview'
import { SharedLinks } from './export/SharedLinks'
import { ExportTabs } from './export/controls'

type Manual = ExportRenderRequest['manual']

export default function ExportDialog({ source, onClose }: { source: ConversationDto; onClose: () => void }) {
  const t = useTranslate()
  const session = useConversationExport(source.id)
  const { draft, review, busy, error } = session
  const publicSharing = useCapability('publicConversationSharing')
  const client = useQueryClient()
  const [tab, setTab] = useState<'prepare' | 'links'>('prepare')
  const [stage, setStage] = useState(0)
  const [reviewTab, setReviewTab] = useState<'detected' | 'text' | 'images'>('detected')
  const [options, setOptions] = useState<ExportOptions | null>(null)
  const [kept, setKept] = useState<string[]>([])
  const [manual, setManual] = useState<Manual>([])
  const [reviewedImages, setReviewedImages] = useState<string[]>([])
  const [published, setPublished] = useState<ConversationShareDto | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [previewLoaded, setPreviewLoaded] = useState(false)
  const [rechecked, setRechecked] = useState(false)
  const copy = useCopy()
  const initialized = useRef<string | null>(null)
  const previous = useRef<{ review: ExportDraftDto; kept: string[]; manual: Manual; images: string[] } | null>(null)
  const selectionOptions = options ? { from: options.from, to: options.to, excluded: options.excluded, tools: options.tools,
    toolOverrides: options.toolOverrides, images: options.images } : null
  const selection = useQuery({
    queryKey: ['export-selection', draft?.id, selectionOptions],
    queryFn: () => api.post<ExportSelectionDto>(exportUrl(draft!.id) + '/selection', selectionOptions),
    enabled: !!draft && draft.status !== 'preparing' && !!options,
    staleTime: Infinity,
  })

  useEffect(() => {
    if (draft && initialized.current !== draft.id) {
      initialized.current = draft.id
      previous.current = null
      setOptions(draft.options); setStage(0); setPublished(null); setKept([]); setManual([]); setReviewedImages([]); setRechecked(false)
    }
  }, [draft])
  useEffect(() => { setPreviewLoaded(false) }, [draft?.revision])
  useEffect(() => {
    if (!review || !previous.current) return
    const old = previous.current
    const decisions = reconcileReview({ fields: old.review.fields ?? [], findings: old.review.findings ?? [], kept: old.kept, manual: old.manual },
      review.fields ?? [], review.findings ?? [])
    setKept(decisions.kept); setManual(decisions.manual)
    setReviewedImages(old.images.filter(id => review.selectedImages?.some(image => image.id === id)))
    previous.current = null
    setRechecked(true)
  }, [review])

  const prepare = async () => {
    if (!options) return
    const normalized = { ...options, title: options.title.trim() }
    setOptions(normalized)
    setStage(1)
    if (review && JSON.stringify(review.options) === JSON.stringify(normalized) && (draft?.status === 'review' || draft?.status === 'complete')) return
    previous.current = review ? { review, kept, manual, images: reviewedImages } : null
    setKept([]); setManual([]); setReviewedImages([]); setPublished(null); setRechecked(false); setReviewTab('detected')
    await session.analyze(normalized)
  }
  const preview = async () => {
    setPublished(null); setStage(2)
    await session.render({ kept, manual, reviewedImages })
  }
  const publish = async (expiresAt: number | null) => {
    const share = await session.publish(expiresAt)
    if (share) {
      setPublished(share); setPublishOpen(false)
      void client.invalidateQueries({ queryKey: ['conversation-shares', source.id] })
    }
  }
  const activeLabel = draft?.status === 'analyzing' ? 'export.analyzing' : draft?.status === 'rendering' ? 'export.rendering' : 'export.preparing'
  const steps = [t('export.step.content'), t('export.step.privacy'), t('export.step.preview')]
  const artifact = draft ? exportUrl(draft.id) + '/html?revision=' + draft.revision : ''
  const remainingImages = (review?.selectedImages ?? []).filter(image => !reviewedImages.includes(image.id)).length
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
      <Dialog.Content onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => {
        if (expanded) { event.preventDefault(); setExpanded(false) }
      }} className="surface fixed inset-0 z-50 flex min-h-0 flex-col overflow-clip border-line shadow-pop sm:inset-5 sm:rounded-lg sm:border lg:inset-x-[max(1.25rem,calc((100vw-1200px)/2))]" aria-describedby="export-description">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
          <div>
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold"><Share2 size={19} className="text-accent" /><span>{t('export.title')}</span></Dialog.Title>
            <Dialog.Description id="export-description" className="sr-only">{t('export.description')}</Dialog.Description>
            {!expanded && stage === 0 && <p aria-hidden="true" className="mt-1 text-sm text-ink-faint">{t('export.description')}</p>}
          </div>
          {expanded ? <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>{t('export.back')}</Button>
            : <Dialog.Close asChild><IconButton label={t('common.close')}><X size={19} /></IconButton></Dialog.Close>}
        </div>
        {!expanded && publicSharing && <div className="shrink-0 px-4 sm:px-6">
          <ExportTabs id="export-main" label={t('export.title')} value={tab} onChange={setTab} tabs={[
            { value: 'prepare', label: t('export.tab.prepare') }, { value: 'links', label: t('export.tab.links') },
          ]} />
        </div>}
        <div id="export-main-panel" role={publicSharing ? 'tabpanel' : undefined} aria-labelledby={publicSharing ? 'export-main-' + tab : undefined} className="flex min-h-0 flex-1 flex-col">
        {tab === 'links' ? <SharedLinks conversationId={source.id} /> : <>
          {!expanded && <ol className="flex shrink-0 items-center gap-3 border-b border-line px-4 sm:gap-7 sm:px-6" aria-label={t('export.tab.prepare')}>
            {steps.map((label, index) => <li key={label} aria-current={stage === index ? 'step' : undefined}>
              <button type="button" disabled={index > stage || busy} onClick={() => setStage(index)}
                className={cx('flex min-h-11 items-center gap-1.5 rounded text-xs focus-visible:outline-2 focus-visible:outline-accent sm:text-sm', stage === index ? 'text-accent font-semibold' : 'text-ink-faint')}>
                <span className={cx('flex size-5 items-center justify-center rounded-full text-[11px]', stage === index ? 'bg-accent/15' : 'bg-surface-high')}>
                  {stage > index ? <Check size={12} /> : index + 1}
                </span>{label}
              </button>
            </li>)}
          </ol>}
          {error && !publishOpen && <div className="shrink-0 px-4 pt-3 sm:px-6"><Banner>{error}</Banner>
            {stage === 1 && !busy && <Button size="sm" variant="ghost" onClick={() => draft?.status === 'review' && !review ? session.retry() : void prepare()}>{t('export.retry')}</Button>}
          </div>}
          {busy || !draft || !options ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6" role="status" aria-live="polite">
            {!error && <LoaderCircle size={28} className="text-accent motion-safe:animate-spin" />}
            <p className="text-sm text-ink-soft">{error ? t('export.failed') : t(activeLabel)}</p>
            {draft && busy && <><progress className="h-1 w-52 accent-[var(--sg-accent)]" max={1} value={draft.progress} />
              <span className="text-xs text-ink-faint">{t('export.progress', { percent: Math.round(draft.progress * 100) })}</span></>}
            {error && <Button onClick={session.retry}>{t('export.retry')}</Button>}
            <Button variant="ghost" onClick={onClose}>{t('export.cancel')}</Button>
          </div> : stage === 0 ? <>
            {selection.error && <div className="px-4 pt-3 sm:px-6"><Banner>{selection.error.message}</Banner><Button size="sm" variant="ghost" onClick={() => void selection.refetch()}>{t('export.retry')}</Button></div>}
            <ContentSelection draftId={draft.id} source={source} options={options} setOptions={setOptions} total={draft.total} selection={selection.data} />
          </> : stage === 1 ? review ? <>
            {rechecked && <p role="status" className="shrink-0 px-4 pt-3 text-xs text-ink-faint sm:px-6">{t('export.privacy.changed')}</p>}
            <PrivacyReview draftId={draft.id} fields={review.fields ?? []} findings={review.findings ?? []} kept={kept} setKept={setKept}
              manual={manual} setManual={setManual} images={review.selectedImages ?? []} reviewed={reviewedImages} setReviewed={setReviewedImages}
              tab={reviewTab} setTab={setReviewTab} />
          </> : <div className="flex flex-1 items-center justify-center p-6 text-sm text-ink-faint">{error ? t('export.failed') : t('export.analyzing')}</div>
          : <div className="flex min-h-0 flex-1 flex-col">
            {!expanded && <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-1 sm:px-6">
              <p className="text-xs text-ink-faint">{t('export.preview.hint')}</p>
              <IconButton label={t('export.preview.expand')} onClick={() => setExpanded(true)} disabled={!previewLoaded}><Maximize2 size={17} /></IconButton>
            </div>}
            {draft.status === 'complete' && <iframe title={t('export.preview.frame')} src={artifact} sandbox="allow-popups allow-popups-to-escape-sandbox"
              onLoad={() => setPreviewLoaded(true)} className="min-h-0 w-full flex-1 border-y border-line bg-white" />}
            {!expanded && <div className="shrink-0 px-4 py-2 sm:px-6">
              {publicSharing && draft.canPublish ? published ? <div role="status" className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-2 text-xs"><Check size={16} className="text-accent" />{t('export.published')}</span>
                <input aria-label={t('export.published')} readOnly value={published.url ?? ''} onFocus={event => event.target.select()} className="min-w-0 flex-1 rounded border border-line bg-sunken px-3 py-2 text-xs" />
                <Button variant="secondary" size="sm" icon={<Copy size={15} />} onClick={() => copy.copy(published.url ?? '')}>
                  {t(copy.state === 'copied' ? 'export.copied' : 'export.copy')}
                </Button>
                {copy.state === 'failed' && <p className="w-full text-xs text-ink-faint">{t('export.copyFailed')}</p>}
              </div> : <Button variant="secondary" className="w-full sm:w-auto" icon={<Link2 size={16} />} onClick={() => setPublishOpen(true)} disabled={!previewLoaded || draft.status !== 'complete'}>{t('export.publish')}</Button>
              : <p className="text-xs text-ink-faint">{t(publicSharing ? 'export.publish.unavailable' : 'export.publish.desktop')}</p>}
            </div>}
          </div>}
          {!busy && draft && options && !expanded && <div className="shrink-0 border-t border-line px-4 py-3 sm:px-6">
            {stage === 0 && <p className="mb-2 text-xs text-ink-faint" role="status">
              {!options.title.trim() ? t('export.selection.titleRequired') : selection.data?.included === 0 ? t('export.selection.empty')
                : selection.data ? t('export.selection.detail', { messages: selection.data.messages, tools: selection.data.tools, images: selection.data.images }) : t('export.loading')}
            </p>}
            {stage === 1 && remainingImages > 0 && <button className="mb-2 min-h-9 text-sm font-medium text-accent hover:underline" onClick={() => setReviewTab('images')}>{t('export.images.remaining', { count: remainingImages })}</button>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" icon={<ChevronLeft size={16} />} onClick={() => stage === 0 ? onClose() : setStage(stage - 1)}>{t(stage === 0 ? 'export.cancel' : 'export.back')}</Button>
              {stage === 0 && <Button icon={<ShieldCheck size={16} />} disabled={!options.title.trim() || !selection.data?.included} onClick={() => void prepare()}>{t('export.analyze')}</Button>}
              {stage === 1 && <Button icon={<Eye size={16} />} disabled={!review || draft.status === 'failed' || remainingImages > 0} onClick={() => void preview()}>{t('export.preview.create')}</Button>}
              {stage === 2 && <a href={draft.status === 'complete' && previewLoaded ? artifact + '&download=1' : undefined} download
                aria-disabled={draft.status !== 'complete' || !previewLoaded}
                className={cx('inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium gradient-accent text-accent-ink',
                  (draft.status !== 'complete' || !previewLoaded) && 'pointer-events-none opacity-40')}><Download size={16} />{t('export.download')}</a>}
            </div>
          </div>}
        </>}
        </div>
        {publishOpen && <PublishDialog busy={session.publishing} error={error} onClose={() => setPublishOpen(false)} onPublish={publish} />}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function PublishDialog({ busy, error, onClose, onPublish }: { busy: boolean; error: string | null; onClose: () => void; onPublish: (expiresAt: number | null) => Promise<void> }) {
  const t = useTranslate()
  const [expiry, setExpiry] = useState<'30' | 'never' | 'custom'>('30')
  const [date, setDate] = useState('')
  const expiresAt = expiry === 'never' ? null : expiry === '30' ? Date.now() + 30 * 86400_000 : new Date(date + 'T23:59:59').getTime()
  const valid = expiresAt === null || expiresAt > Date.now()
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content className="surface fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[min(30rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-line p-5 shadow-pop">
        <Dialog.Title className="font-semibold">{t('export.publish')}</Dialog.Title>
        <Dialog.Description className="text-sm leading-relaxed text-ink-soft">{t('export.publish.hint')} {t('export.publish.immutable')}</Dialog.Description>
        {error && <Banner>{error}</Banner>}
        <Select label={t('export.expiry')} value={expiry} onChange={setExpiry} options={[
          { value: '30', label: t('export.expiry.30') }, { value: 'custom', label: t('export.expiry.custom') }, { value: 'never', label: t('export.expiry.never') },
        ]} />
        {expiry === 'custom' && <Field label={t('export.expiry.date')} type="date" value={date} onChange={event => setDate(event.target.value)} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('export.cancel')}</Button>
          <Button busy={busy} disabled={!valid} icon={<Link2 size={16} />} onClick={() => void onPublish(expiresAt)}>{t('export.publish')}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
