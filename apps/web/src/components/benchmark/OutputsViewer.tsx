import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown, ChevronLeft, ChevronRight, Columns3, Download, ExternalLink, Eye, FileText, GalleryHorizontal, Maximize2,
  MessageSquareText, Monitor, MonitorSmartphone, RotateCw, Scaling, Smartphone, Tablet, X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  benchmarkPreviewUrl,
  variantAgent,
  type BenchmarkDeliverable,
  type BenchmarkDeliverableKind,
  type BenchmarkDto,
  type BenchmarkRunDto,
  type BenchmarkVariant,
} from '@sillage/protocol'
import { formatBytes } from '../../lib/attachments'
import { formatMetric, isOpenRun, RUN_STATUS_LABELS, useOutputsLayout, type OutputsLayout } from '../../lib/benchmarks'
import { locale, useTranslate, type MessageKey } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Markdown } from '../chat/Markdown'
import { RatingInput } from './RatingInput'
import { IconButton, Menu, MenuCheckboxItem, MenuItem, MenuLabel, MenuSeparator, Segmented, Select, cx } from '../ui'

/** What people compare first: what renders, then what plays, then what reads. */
const KIND_ORDER: Record<BenchmarkDeliverableKind, number> = { page: 0, image: 1, video: 2, audio: 3, pdf: 4, text: 5, other: 6 }

const OUTPUT_KIND_LABELS: Record<BenchmarkDeliverableKind, MessageKey> = {
  page: 'benchmark.outputs.page', image: 'benchmark.outputs.image', video: 'benchmark.outputs.video',
  audio: 'benchmark.outputs.audio', pdf: 'benchmark.outputs.pdf', text: 'benchmark.outputs.text', other: 'benchmark.outputs.other',
}

/** Enough source to judge a file side by side; the whole file opens in a tab. */
const TEXT_PREVIEW_BYTES = 64 * 1024

/** Pick of a card that is not a file. A run folder cannot hold a path starting with a colon-less sentinel like this one. */
const RESPONSE = '\u0000response'

/** Widths pages are rendered at when not left to the card. */
const VIEWPORT_WIDTHS: Record<Exclude<OutputsLayout['viewport'], 'fit'>, number> = { desktop: 1280, tablet: 768, phone: 390 }

const HEIGHTS: Record<OutputsLayout['height'], string> = {
  compact: 'h-72',
  medium: 'h-[34rem]',
  tall: 'h-[calc(100dvh-13rem)] min-h-96',
}

/** Files every project carries: never what a reader wants a card to open on. */
const MANIFEST = /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|[^/]*\.lock|[^/]*\.config\.[cm]?[jt]s|README[^/]*|LICENSE[^/]*)$/i

/** Narrowest card the automatic layout accepts, and the grid's gap, in pixels. */
const AUTO_CARD_MIN = 380
const AUTO_GAP = 12

/** Up to this many runs per variant they sit in the toolbar; beyond, a list keeps it on one line. */
const MAX_REPETITION_SEGMENTS = 4

interface Column {
  variant: BenchmarkVariant
  run: BenchmarkRunDto | null
  /** Displayable files, the one to open first leading. */
  files: BenchmarkDeliverable[]
}

function sortedFiles(run: BenchmarkRunDto | null): BenchmarkDeliverable[] {
  return [...(run?.files ?? [])].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.path.split('/').length - b.path.split('/').length
    || Number(/(?:^|\/)index\.html?$/i.test(b.path)) - Number(/(?:^|\/)index\.html?$/i.test(a.path))
    || a.path.localeCompare(b.path))
}

/**
 * What each variant produced, one card per variant showing one thing at a time: the page it
 * built, another of its files, or its final answer. Agents name their files differently, so a
 * card opens on the variant's main production rather than on a shared path. The layout (all at
 * once or one at a time, cards per row, height, the width pages render at) is the reader's and is
 * remembered on the device.
 */
export function OutputsViewer({
  benchmark,
  order,
  nameOf,
  blind,
}: {
  benchmark: BenchmarkDto
  /** Variant ids in card order: shuffled during a blind review. */
  order: string[]
  /** Card heading for a variant: its letter while blind, its name otherwise. */
  nameOf: (variantId: string) => { label: ReactNode; text: string }
  /** Hides CLI icons and measures, which would give the variant away. */
  blind: boolean
}) {
  const t = useTranslate()
  const [layout, setLayout] = useOutputsLayout()
  const [repetition, setRepetition] = useState(1)
  const [hidden, setHidden] = useState<string[]>([])
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [focused, setFocused] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const columns = useMemo(
    () => order.flatMap((variantId): Column[] => {
      const variant = benchmark.variants.find((entry) => entry.id === variantId)
      if (!variant) return []
      const run = benchmark.runs.find((entry) => entry.variantId === variant.id && entry.repetition === repetition) ?? null
      return [{ variant, run, files: sortedFiles(run) }]
    }),
    [benchmark, order, repetition],
  )
  const visible = columns.filter((column) => !hidden.includes(column.variant.id))
  const shown = layout.mode === 'focus'
    ? visible.filter((column) => column.variant.id === (visible.some((entry) => entry.variant.id === focused) ? focused : visible[0]?.variant.id))
    : visible
  const anyFile = columns.some((column) => column.files.length > 0)
  const anyPage = columns.some((column) => column.files.some((file) => file.kind === 'page'))

  /** A card's own pick while it still exists, else what the toolbar asks every card to show. */
  const pickOf = (column: Column): string => {
    const own = picks[column.variant.id]
    if (own === RESPONSE || (own && column.files.some((file) => file.path === own))) return own
    const first = column.files.find((file) => file.kind !== 'other' && !MANIFEST.test(file.path))
    return layout.show === 'responses' || !first ? RESPONSE : first.path
  }

  const step = (from: string, by: number) => {
    const index = visible.findIndex((column) => column.variant.id === from)
    return visible[(index + by + visible.length) % visible.length]?.variant.id ?? from
  }

  const card = (column: Column, full: boolean) => (
    <OutputCard
      key={column.variant.id}
      benchmarkId={benchmark.id}
      column={column}
      name={nameOf(column.variant.id)}
      blind={blind}
      pick={pickOf(column)}
      onPick={(pick) => setPicks((current) => ({ ...current, [column.variant.id]: pick }))}
      viewport={layout.viewport}
      heightClass={full ? 'min-h-0 flex-1' : HEIGHTS[layout.height]}
      onExpand={full ? null : () => setExpanded(column.variant.id)}
    />
  )

  const switcher = (current: string | undefined, onChange: (variantId: string) => void) => (
    <div className="flex min-w-0 items-center gap-1" data-output-switcher>
      <IconButton size="sm" label={t('benchmark.outputs.previous')} disabled={visible.length < 2} onClick={() => current && onChange(step(current, -1))}><ChevronLeft size={16} /></IconButton>
      <IconButton size="sm" label={t('benchmark.outputs.next')} disabled={visible.length < 2} onClick={() => current && onChange(step(current, 1))}><ChevronRight size={16} /></IconButton>
      <div role="tablist" aria-label={t('benchmark.outputs.variants')} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {visible.map((column) => (
          <button
            key={column.variant.id}
            type="button"
            role="tab"
            aria-selected={column.variant.id === current}
            onClick={() => onChange(column.variant.id)}
            className={cx(
              'inline-flex h-10 max-w-56 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors md:h-8 pointer-coarse:h-10',
              column.variant.id === current ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
            )}
          >
            {blind ? null : <AgentIcon agent={variantAgent(column.variant)} size={13} />}
            <span className="truncate">{nameOf(column.variant.id).label}</span>
          </button>
        ))}
      </div>
    </div>
  )

  // Automatic columns: as many as fit, then evened out so four cards make two rows of two rather
  // than three and an orphan stretched across the page.
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridWidth, setGridWidth] = useState(0)
  useEffect(() => {
    const element = gridRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setGridWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fitting = Math.max(1, Math.min(shown.length, Math.floor((gridWidth + AUTO_GAP) / (AUTO_CARD_MIN + AUTO_GAP)) || 1))
  const autoColumns = Math.ceil(shown.length / Math.ceil(shown.length / fitting)) || 1

  const repetitions = Array.from({ length: benchmark.repetitions }, (_, index) => index + 1)
  const expandedColumn = visible.find((column) => column.variant.id === expanded) ?? null
  const viewportControl = anyPage ? (
    <Segmented
      label={t('benchmark.outputs.viewport')}
      value={layout.viewport}
      onChange={(viewport) => setLayout({ viewport })}
      options={[
        { value: 'fit', label: t('benchmark.outputs.viewport.fit'), icon: <Scaling size={15} /> },
        { value: 'desktop', label: t('benchmark.outputs.viewport.desktop'), icon: <Monitor size={15} /> },
        { value: 'tablet', label: t('benchmark.outputs.viewport.tablet'), icon: <Tablet size={15} /> },
        { value: 'phone', label: t('benchmark.outputs.viewport.phone'), icon: <Smartphone size={15} /> },
      ]}
    />
  ) : null

  return (
    <div className="flex flex-col gap-3" data-benchmark-deliverables data-output-mode={layout.mode}>
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t('benchmark.outputs.toolbar')}>
        <Segmented
          label={t('benchmark.outputs.mode')}
          value={layout.mode}
          onChange={(mode) => setLayout({ mode })}
          options={[
            { value: 'grid', label: t('benchmark.outputs.mode.grid'), icon: <Columns3 size={15} />, text: t('benchmark.outputs.mode.grid') },
            { value: 'focus', label: t('benchmark.outputs.mode.focus'), icon: <GalleryHorizontal size={15} />, text: t('benchmark.outputs.mode.focus') },
          ]}
        />
        {anyFile ? (
          <Segmented
            label={t('benchmark.outputs.show')}
            value={layout.show}
            // A general choice replaces what each card had picked: the toolbar must be believed.
            onChange={(show) => { setPicks({}); setLayout({ show }) }}
            options={[
              { value: 'outputs', label: t('benchmark.outputs.show.outputs'), icon: <MonitorSmartphone size={15} />, text: t('benchmark.outputs.show.outputs') },
              { value: 'responses', label: t('benchmark.outputs.show.responses'), icon: <MessageSquareText size={15} />, text: t('benchmark.outputs.show.responses') },
            ]}
          />
        ) : null}
        {viewportControl}
        {layout.mode === 'grid' ? (
          <Segmented
            // One card fills a phone anyway: the choice only exists where it changes something.
            className="max-md:hidden"
            label={t('benchmark.outputs.columns')}
            value={String(layout.columns) as '0' | '1' | '2' | '3' | '4'}
            onChange={(value) => setLayout({ columns: Number(value) as OutputsLayout['columns'] })}
            options={[
              { value: '0', label: t('benchmark.outputs.columns.auto'), text: t('benchmark.outputs.columns.autoShort') },
              ...(['1', '2', '3', '4'] as const).map((value) => ({ value, label: t('benchmark.outputs.columns.count', { count: Number(value) }), text: value })),
            ]}
          />
        ) : null}
        <Segmented
          label={t('benchmark.outputs.height')}
          value={layout.height}
          onChange={(height) => setLayout({ height })}
          options={[
            { value: 'compact', label: t('benchmark.outputs.height.compact'), text: 'S' },
            { value: 'medium', label: t('benchmark.outputs.height.medium'), text: 'M' },
            { value: 'tall', label: t('benchmark.outputs.height.tall'), text: 'L' },
          ]}
        />
        {columns.length > 2 ? (
          <Menu align="start" trigger={
            <button type="button" className="inline-flex h-11 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs font-medium text-ink-soft hover:border-line-strong hover:text-ink md:h-8 pointer-coarse:h-11">
              <Eye size={14} />{t('benchmark.outputs.visible', { shown: visible.length, total: columns.length })}<ChevronDown size={13} />
            </button>
          }>
            {columns.map((column) => (
              <MenuCheckboxItem
                key={column.variant.id}
                checked={!hidden.includes(column.variant.id)}
                // The last card stays: an empty comparison has nothing to offer but this menu.
                disabled={visible.length === 1 && !hidden.includes(column.variant.id)}
                onCheckedChange={(checked) => setHidden((current) => (checked ? current.filter((id) => id !== column.variant.id) : [...current, column.variant.id]))}
              >
                {nameOf(column.variant.id).text}
              </MenuCheckboxItem>
            ))}
          </Menu>
        ) : null}
        {benchmark.repetitions > 1 && benchmark.repetitions <= MAX_REPETITION_SEGMENTS ? (
          <Segmented
            className="ml-auto"
            label={t('benchmark.outputs.repetition')}
            value={String(repetition)}
            onChange={(value) => setRepetition(Number(value))}
            options={repetitions.map((n) => ({ value: String(n), label: t('benchmark.table.repetition', { n }), text: t('benchmark.table.repetition', { n }) }))}
          />
        ) : benchmark.repetitions > 1 ? (
          <Select
            className="ml-auto w-36"
            value={String(repetition)}
            onChange={(value) => setRepetition(Number(value))}
            options={repetitions.map((n) => ({ value: String(n), label: t('benchmark.table.repetition', { n }) }))}
          />
        ) : null}
      </div>

      {layout.mode === 'focus' ? switcher(shown[0]?.variant.id, setFocused) : null}

      <div
        ref={gridRef}
        className={cx('grid gap-3', layout.mode === 'grid' && 'max-md:flex max-md:snap-x max-md:snap-mandatory max-md:overflow-x-auto max-md:pb-2')}
        style={{
          gridTemplateColumns: layout.mode === 'focus' ? '1fr'
            : layout.columns === 0 ? `repeat(${autoColumns}, minmax(0, 1fr))`
            : `repeat(${Math.min(layout.columns, Math.max(1, shown.length))}, minmax(0, 1fr))`,
        }}
        // Flipping between variants is the point of the one-at-a-time view: arrows do it from anywhere in it.
        onKeyDown={layout.mode === 'focus' ? (event) => {
          if ((event.target as HTMLElement).closest('input, textarea, [role="radiogroup"]')) return
          const by = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
          const current = shown[0]?.variant.id
          if (by && current) { event.preventDefault(); setFocused(step(current, by)) }
        } : undefined}
      >
        {shown.map((column) => (
          <div key={column.variant.id} className={cx('flex min-w-0 flex-col', layout.mode === 'grid' && 'max-md:w-[88vw] max-md:shrink-0 max-md:snap-start')}>
            {card(column, false)}
          </div>
        ))}
      </div>

      {!anyFile && columns.every(({ run }) => run && !isOpenRun(run)) ? (
        <p className="text-xs text-ink-faint">{t('benchmark.outputs.noFiles')}</p>
      ) : null}

      <Dialog.Root open={!!expandedColumn} onOpenChange={(open) => { if (!open) setExpanded(null) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            className="surface fixed inset-0 top-[var(--sg-window-bar,0px)] z-50 flex min-h-0 flex-col gap-2 p-2 sm:p-3"
            data-output-expanded
            onKeyDown={(event) => {
              if ((event.target as HTMLElement).closest('input, textarea, [role="radiogroup"]')) return
              const by = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              if (by && expanded) { event.preventDefault(); setExpanded(step(expanded, by)) }
            }}
          >
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Dialog.Title className="sr-only">{t('benchmark.outputs.expanded')}</Dialog.Title>
              <div className="min-w-0 flex-1">{switcher(expandedColumn?.variant.id, setExpanded)}</div>
              {viewportControl}
              <Dialog.Close asChild><IconButton label={t('common.close')}><X size={18} /></IconButton></Dialog.Close>
            </div>
            {expandedColumn ? card(expandedColumn, true) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

function OutputCard({ benchmarkId, column, name, blind, pick, onPick, viewport, heightClass, onExpand }: {
  benchmarkId: string
  column: Column
  name: { label: ReactNode; text: string }
  blind: boolean
  pick: string
  onPick: (pick: string) => void
  viewport: OutputsLayout['viewport']
  heightClass: string
  /** Null inside the full-screen view, which is already as large as it gets. */
  onExpand: (() => void) | null
}) {
  const t = useTranslate()
  const { variant, run, files } = column
  const [reloads, setReloads] = useState(0)
  const file = pick === RESPONSE ? null : files.find((entry) => entry.path === pick) ?? null
  const url = file && run?.previewToken ? benchmarkPreviewUrl(run.previewToken, file.path) : null
  const lang = locale()
  const kinds = [...new Set(files.map((entry) => entry.kind))]

  return (
    <section
      className={cx('flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface', onExpand ? null : 'min-h-0 flex-1')}
      data-output-column={name.text}
      data-output-pick={file ? file.path : 'response'}
      aria-label={name.text}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-line py-1 pr-1 pl-3">
        {blind ? null : <AgentIcon agent={variantAgent(variant)} size={15} />}
        <h3 className="min-w-0 shrink truncate text-sm font-medium">{name.label}</h3>
        {run && run.status !== 'succeeded' ? (
          <span className={cx('shrink-0 text-xs', isOpenRun(run) ? 'text-accent' : 'text-caution')}>{t(isOpenRun(run) ? 'benchmark.outputs.pending' : RUN_STATUS_LABELS[run.status])}</span>
        ) : null}
        <span className="flex-1" />
        <Menu trigger={
          <button type="button" aria-label={t('benchmark.outputs.pick')} className="inline-flex h-11 max-w-[45%] min-w-0 items-center gap-1 rounded-md px-2 text-xs text-ink-soft hover:bg-surface-high hover:text-ink md:h-7 pointer-coarse:h-11">
            {file ? <FileText size={13} className="shrink-0" /> : <MessageSquareText size={13} className="shrink-0" />}
            <span className="truncate font-mono">{file ? file.path : t('benchmark.outputs.response')}</span>
            <ChevronDown size={12} className="shrink-0" />
          </button>
        }>
          <div className="max-h-[60vh] max-w-[min(26rem,90vw)] overflow-y-auto">
            <MenuItem icon={<MessageSquareText size={14} />} onSelect={() => onPick(RESPONSE)}>{t('benchmark.outputs.response')}</MenuItem>
            {kinds.map((kind) => (
              <div key={kind}>
                <MenuSeparator />
                <MenuLabel>{t(OUTPUT_KIND_LABELS[kind])}</MenuLabel>
                {files.filter((entry) => entry.kind === kind).map((entry) => (
                  <MenuItem key={entry.path} onSelect={() => onPick(entry.path)}>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
                    <span className="shrink-0 text-xs text-ink-faint tabular-nums">{formatBytes(entry.sizeBytes)}</span>
                  </MenuItem>
                ))}
              </div>
            ))}
          </div>
        </Menu>
        {file?.kind === 'page' ? <IconButton size="sm" label={t('benchmark.outputs.reload')} onClick={() => setReloads((count) => count + 1)}><RotateCw size={14} /></IconButton> : null}
        {url && file && file.kind !== 'other' ? (
          <a href={url} target="_blank" rel="noreferrer"><IconButton size="sm" label={t('benchmark.outputs.open')} tabIndex={-1}><ExternalLink size={14} /></IconButton></a>
        ) : null}
        {url ? <a href={`${url}?download=1`}><IconButton size="sm" label={t('benchmark.outputs.download')} tabIndex={-1}><Download size={14} /></IconButton></a> : null}
        {onExpand ? <IconButton size="sm" label={t('benchmark.outputs.expand')} onClick={onExpand}><Maximize2 size={14} /></IconButton> : null}
      </header>

      <div className={cx('relative min-w-0 bg-sunken', heightClass)}>
        {file && url ? <FileView key={`${file.path}-${reloads}`} file={file} url={url} viewport={viewport} />
          : run?.response ? <div className="h-full overflow-y-auto bg-surface px-4 py-3 text-sm"><Markdown text={run.response} /></div>
          : <Nothing>{t(run && isOpenRun(run) ? 'benchmark.outputs.waiting' : 'benchmark.outputs.noResponse')}</Nothing>}
      </div>

      {run && !isOpenRun(run) ? (
        <footer className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-1 border-t border-line px-3 py-1.5">
          <RatingInput benchmarkId={benchmarkId} run={run} label={t('benchmark.rating.of', { name: name.text })} />
          {/* Speed and cost betray a model as surely as its name. */}
          {blind || !run.metrics ? null : (
            <p className="py-2 text-xs text-ink-faint tabular-nums">
              {[formatMetric('durationMs', run.metrics.durationMs ?? null, lang), run.metrics.costUsd != null ? formatMetric('costUsd', run.metrics.costUsd, lang) : null]
                .filter(Boolean).join(' · ')}
            </p>
          )}
        </footer>
      ) : null}
    </section>
  )
}

function Nothing({ children }: { children: ReactNode }) {
  return <p className="flex h-full items-center justify-center px-4 text-center text-xs text-ink-faint">{children}</p>
}

function FileView({ file, url, viewport }: { file: BenchmarkDeliverable; url: string; viewport: OutputsLayout['viewport'] }) {
  const name = file.path.split('/').pop() ?? file.path
  switch (file.kind) {
    case 'page':
      return <PageFrame title={file.path} url={url} viewport={viewport} />
    case 'image':
      return <img src={url} alt={name} loading="lazy" className="size-full object-contain" />
    case 'video':
      return <video controls preload="metadata" src={url} className="size-full bg-black" />
    case 'audio':
      return <div className="flex h-full items-center px-4"><audio controls preload="metadata" src={url} className="w-full" /></div>
    case 'pdf':
      return <iframe title={file.path} src={url} className="size-full" />
    case 'text':
      return <TextPreview url={url} />
    default:
      return <Nothing>{name} · {formatBytes(file.sizeBytes)}</Nothing>
  }
}

/**
 * A page at the width it was asked to be judged at. Wider than the card, the frame is scaled down
 * rather than cropped: three desktop pages side by side stay three desktop pages, only smaller.
 */
function PageFrame({ title, url, viewport }: { title: string; url: string; viewport: OutputsLayout['viewport'] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const target = viewport === 'fit' ? null : VIEWPORT_WIDTHS[viewport]
  const scale = target && box.width ? Math.min(1, box.width / target) : 1

  return (
    <div ref={ref} className="size-full overflow-hidden" data-output-scale={scale.toFixed(3)}>
      {/* Sandboxed twice: by this attribute and by the policy the route sends with the page. */}
      <iframe
        title={title}
        src={url}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        referrerPolicy="no-referrer"
        className="block border-0 bg-white"
        style={target ? {
          width: target,
          height: box.height / scale,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          marginLeft: Math.max(0, (box.width - target * scale) / 2),
        } : { width: '100%', height: '100%' }}
      />
    </div>
  )
}

function TextPreview({ url }: { url: string }) {
  const { data, isError } = useQuery({
    queryKey: ['benchmark-preview', url],
    queryFn: async () => {
      const response = await fetch(url, { headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } })
      if (!response.ok) throw new Error(String(response.status))
      return response.text()
    },
    staleTime: Infinity,
  })
  if (isError) return <Nothing>—</Nothing>
  return (
    <pre className={cx('size-full overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-ink-soft', data === undefined && 'animate-pulse')}>
      {data ?? ' '}
    </pre>
  )
}
