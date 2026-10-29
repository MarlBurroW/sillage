import { LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ConversationDto, ExportItemDto, ExportItemsDto, ExportOptions, ExportSelectionDto } from '@sillage/protocol'
import { exportUrl, exportImageUrl } from '../../../lib/conversation-export'
import { api } from '../../../lib/api'
import { useTranslate } from '../../../lib/i18n'
import { useMediaQuery } from '../../../lib/viewport'
import { AgentIcon, AGENT_LABELS } from '../../AgentIcon'
import { Banner, Button, Field, IconButton, Select, cx } from '../../ui'
import { CheckField, textareaClass } from './controls'
type ToolOptions = ExportOptions['tools']

function ToolSettings({ value, onChange }: { value: ToolOptions; onChange: (value: ToolOptions) => void }) {
  const t = useTranslate()
  return <div className="flex flex-col gap-2">
    <Select label={t('export.tools')} value={value.mode} onChange={mode => onChange({ ...value, mode })}
      options={(['summary', 'hidden', 'details'] as const).map(mode => ({ value: mode, label: t(('export.tools.' + mode) as 'export.tools.summary') }))} />
    {value.mode === 'details' && <div className="flex flex-wrap gap-x-5">
      <CheckField checked={value.input} onChange={input => onChange({ ...value, input })}>{t('export.tools.input')}</CheckField>
      <CheckField checked={value.output} onChange={output => onChange({ ...value, output })}>{t('export.tools.output')}</CheckField>
    </div>}
    <p className="text-xs leading-relaxed text-ink-faint">{t(('export.tools.' + value.mode + 'Hint') as 'export.tools.summaryHint')}</p>
  </div>
}

export function ContentSelection({ draftId, source, options, setOptions, total, selection }: {
  draftId: string; source: ConversationDto; options: ExportOptions; setOptions: (options: ExportOptions) => void; total: number; selection?: ExportSelectionDto
}) {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const wide = useMediaQuery('(min-width: 1024px)')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [items, setItems] = useState<ExportItemDto[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    request.current?.abort(); request.current = controller
    setItems([]); setNext(null); setLoading(true); setError('')
    const timer = setTimeout(() => {
      void api.get<ExportItemsDto>(exportUrl(draftId) + '/items?query=' + encodeURIComponent(query), controller.signal).then(page => {
        setItems(page.items); setNext(page.next); setLoading(false)
      }).catch(error => { if (!controller.signal.aborted) { setError(String(error.message)); setLoading(false) } })
    }, query ? 200 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [draftId, query])
  const loadMore = async () => {
    const controller = request.current
    if (!controller || controller.signal.aborted) return
    setLoading(true)
    try {
      const page = await api.get<ExportItemsDto>(exportUrl(draftId) + '/items?offset=' + next + '&query=' + encodeURIComponent(query), controller.signal)
      setItems(previous => [...previous, ...page.items]); setNext(page.next)
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t('export.failed')) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const patch = (value: Partial<ExportOptions>) => setOptions({ ...options, ...value })
  const toggle = (list: string[], id: string) => list.includes(id) ? list.filter(value => value !== id) : [...list, id]
  const setRange = (from: string | null, to: string | null) => patch({
    from, to,
    images: options.images.filter(id => (from === null || Number(id.split('.')[0]) >= Number(from)) && (to === null || Number(id.split('.')[0]) <= Number(to))),
  })
  return <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <details open={wide || settingsOpen} onToggle={event => { if (!wide) setSettingsOpen(event.currentTarget.open) }}
        className="self-start rounded-md border border-line p-3 lg:rounded-none lg:border-0 lg:p-0">
        <summary className="cursor-pointer text-sm font-medium text-ink-soft lg:hidden">{t('export.document.presentation')}
          <span className="mt-1 block text-xs font-normal text-ink-faint">{t(('export.tools.' + options.tools.mode) as 'export.tools.summary')}</span>
        </summary>
        <div className="mt-4 flex flex-col gap-5 lg:mt-0">
        <Field label={t('export.document.title')} value={options.title} maxLength={200} onChange={event => patch({ title: event.target.value })} />
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-soft">{t('export.document.introduction')}
          <textarea className={textareaClass} maxLength={5000} value={options.introduction} onChange={event => patch({ introduction: event.target.value })} />
        </label>
        <Field label={t('export.document.author')} value={options.author} maxLength={100} onChange={event => patch({ author: event.target.value })} />
        <Select label={t('export.document.language')} value={options.locale} onChange={locale => patch({ locale })}
          options={[{ value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }]} />
        <ToolSettings value={options.tools} onChange={tools => patch({ tools })} />
        <p className="text-xs leading-relaxed text-ink-faint">{t('export.images.hint')}</p>
        </div>
      </details>
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('export.range')}</h2><span className="text-xs text-accent" role="status">{selection ? t('export.selection.count', { count: selection.included, total }) : t('export.loading')}</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-ink-faint">{t('export.range.hint')}</p>
        <div className="mb-3 space-y-1 border-l-2 border-accent pl-3 text-xs text-ink-soft">
          <p className="truncate">{t('export.range.from')}: {options.from ? selection?.from?.text.slice(0, 85) ?? '…' : t('export.range.start')}</p>
          <p className="truncate">{t('export.range.to')}: {options.to ? selection?.to?.text.slice(0, 85) ?? '…' : t('export.range.end')}</p>
          <div className="flex flex-wrap">
            {(options.from || options.to) && <Button variant="ghost" size="sm" onClick={() => setRange(null, null)}>{t('export.range.reset')}</Button>}
            {options.excluded.length > 0 && <Button variant="ghost" size="sm" onClick={() => patch({ excluded: [] })}>{t('export.range.restore', { count: options.excluded.length })}</Button>}
          </div>
        </div>
        <div className="flex items-end gap-1">
          <div className="flex-1"><Field label={t('export.search')} value={query} maxLength={500} onChange={event => setQuery(event.target.value)} /></div>
          {query && <IconButton label={t('export.search.clear')} onClick={() => setQuery('')}><X size={17} /></IconButton>}
        </div>
        {query && <p className="mt-2 text-xs text-ink-faint">{t('export.search.hint')}</p>}
        {error && <Banner>{error}</Banner>}
        <div className="mt-4 divide-y divide-line">
          {items.map(item => {
            const excluded = options.excluded.includes(item.id)
            const outside = (options.from !== null && Number(item.id) < Number(options.from)) || (options.to !== null && Number(item.id) > Number(options.to))
            const override = options.toolOverrides[item.id]
            const hidden = item.kind === 'tool' && (override ?? options.tools).mode === 'hidden'
            return <article key={item.id} className={cx('py-4', (excluded || outside || hidden) && 'opacity-60')} data-export-item={item.id}>
              <div className="flex items-start gap-3">
                <input aria-label={t('export.include')} aria-describedby={'export-item-' + item.id} type="checkbox" checked={!excluded && !outside && !hidden} disabled={outside || hidden}
                  onChange={() => {
                    const removed = options.images.filter(id => !item.images.some(image => image.id === id))
                    patch({ excluded: toggle(options.excluded, item.id), images: excluded ? options.images : removed })
                  }} className="mt-1 size-4 shrink-0 accent-[var(--sg-accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium text-ink-faint">
                    {item.role === 'assistant' && <AgentIcon agent={source.agent} size={14} />}
                    {item.kind === 'tool' ? t('export.page.activity') : item.role === 'user' ? t('export.page.author') : AGENT_LABELS[source.agent]}
                  </div>
                  <p id={'export-item-' + item.id} className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.text}</p>
                  {hidden && <p className="mt-1 text-xs text-ink-faint">{t('export.tools.omitted')}</p>}
                  {item.kind !== 'tool' && <div className="mt-2 flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" className={options.from === item.id ? 'bg-accent/10 text-accent' : undefined} aria-pressed={options.from === item.id} onClick={() => setRange(item.id, options.to && Number(options.to) < Number(item.id) ? null : options.to)}>{t('export.range.beginHere')}</Button>
                    <Button size="sm" variant="ghost" className={options.to === item.id ? 'bg-accent/10 text-accent' : undefined} aria-pressed={options.to === item.id} onClick={() => setRange(options.from && Number(options.from) > Number(item.id) ? null : options.from, item.id)}>{t('export.range.endHere')}</Button>
                  </div>}
                  {item.kind === 'tool' && !excluded && <details className="mt-2 text-xs text-ink-faint">
                    <summary className="min-h-8 cursor-pointer">{t('export.tools.override')}</summary>
                    <CheckField checked={!override} onChange={() => {
                      const toolOverrides = { ...options.toolOverrides }
                      if (override) delete toolOverrides[item.id]; else toolOverrides[item.id] = { ...options.tools }
                      patch({ toolOverrides })
                    }}>{t('export.tools.inherit')}</CheckField>
                    {override && <ToolSettings value={override} onChange={value => patch({ toolOverrides: { ...options.toolOverrides, [item.id]: value } })} />}
                  </details>}
                  {!excluded && !outside && item.images.map(image => <div key={image.id} className="mt-3">
                    <CheckField checked={options.images.includes(image.id)} disabled={!image.available}
                      onChange={() => patch({ images: toggle(options.images, image.id) })}>{image.label || t('export.images.select')}</CheckField>
                    {!image.available && <p className="text-xs text-ink-faint">{t('export.images.unavailable')}</p>}
                    {options.images.includes(image.id) && <img src={exportImageUrl(draftId, image.id)} alt={image.label} className="mt-1 max-h-60 max-w-full rounded border border-line object-contain" />}
                  </div>)}
                </div>
              </div>
            </article>
          })}
        </div>
        {loading && <p role="status" className="flex items-center gap-2 py-4 text-sm text-ink-faint"><LoaderCircle size={15} className="motion-safe:animate-spin" />{t('export.loading')}</p>}
        {!loading && next !== null && <Button variant="secondary" onClick={() => void loadMore()}>{t('export.loadMore')}</Button>}
        {!loading && !items.length && <p className="py-6 text-sm text-ink-faint">{t(query ? 'export.search.none' : 'export.empty')}</p>}
      </div>
    </div>
  </div>
}
