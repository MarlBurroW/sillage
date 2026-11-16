import { useQuery } from '@tanstack/react-query'
import { Download, ExternalLink } from 'lucide-react'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import {
  benchmarkPreviewUrl,
  variantAgent,
  type BenchmarkDeliverable,
  type BenchmarkDeliverableKind,
  type BenchmarkDto,
} from '@sillage/protocol'
import { formatBytes } from '../../lib/attachments'
import { isOpenRun } from '../../lib/benchmarks'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { AgentIcon } from '../AgentIcon'
import { Markdown } from '../chat/Markdown'
import { RatingInput } from './RatingInput'
import { Select, cx } from '../ui'

/** Rows people compare first: what renders, then what plays, then what reads. */
const KIND_ORDER: Record<BenchmarkDeliverableKind, number> = { page: 0, image: 1, video: 2, audio: 3, pdf: 4, text: 5, other: 6 }

const OUTPUT_KIND_LABELS: Record<BenchmarkDeliverableKind, MessageKey> = {
  page: 'benchmark.outputs.page', image: 'benchmark.outputs.image', video: 'benchmark.outputs.video',
  audio: 'benchmark.outputs.audio', pdf: 'benchmark.outputs.pdf', text: 'benchmark.outputs.text', other: 'benchmark.outputs.other',
}

/** Enough source to judge a file side by side; the whole file opens in a tab. */
const TEXT_PREVIEW_BYTES = 64 * 1024

/**
 * What each variant produced, aligned: one column per variant, one row for the final answer and
 * one per output of the same kind. Agents choose different filenames for the same task, so
 * matching paths would scatter comparable pages across rows. Repetitions are shown one at a time.
 */
export function DeliverablesGrid({
  benchmark,
  order,
  nameOf,
  blind,
}: {
  benchmark: BenchmarkDto
  /** Variant ids in column order: shuffled during a blind review. */
  order: string[]
  /** Column heading for a variant: its letter while blind, its name otherwise. */
  nameOf: (variantId: string) => { label: ReactNode; text: string }
  /** Hides CLI icons, which would give the variant away. */
  blind: boolean
}) {
  const t = useTranslate()
  const [repetition, setRepetition] = useState(1)

  const columns = useMemo(
    () => order.flatMap((variantId) => {
      const variant = benchmark.variants.find((entry) => entry.id === variantId)
      if (!variant) return []
      return [{ variant, run: benchmark.runs.find((run) => run.variantId === variant.id && run.repetition === repetition) ?? null }]
    }),
    [benchmark, order, repetition],
  )

  const outputRows = useMemo(() => {
    const kinds = Object.keys(KIND_ORDER) as BenchmarkDeliverableKind[]
    return kinds.flatMap((kind) => {
      const files = columns.map(({ run }) => (run?.files ?? [])
        .filter((file) => file.kind === kind)
        .sort((a, b) => a.path.split('/').length - b.path.split('/').length
          || Number(/(?:^|\/)index\.html?$/i.test(b.path)) - Number(/(?:^|\/)index\.html?$/i.test(a.path))
          || a.path.localeCompare(b.path)))
      return Array.from({ length: Math.max(0, ...files.map((list) => list.length)) }, (_, index) => ({
        kind, index, files: files.map((list) => list[index] ?? null),
      }))
    })
  }, [columns])

  return (
    <div className="flex flex-col gap-3" data-benchmark-deliverables>
      {benchmark.repetitions > 1 ? (
        <Select
          className="max-w-56"
          label={t('benchmark.outputs.repetition')}
          value={String(repetition)}
          onChange={(value) => setRepetition(Number(value))}
          options={Array.from({ length: benchmark.repetitions }, (_, index) => ({ value: String(index + 1), label: t('benchmark.table.repetition', { n: index + 1 }) }))}
        />
      ) : null}

      {/* Columns snap on phones so one variant fills the width; wide screens show them side by side. */}
      <div className="overflow-x-auto pb-2">
        <div
          className="grid snap-x snap-mandatory gap-3"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(min(85vw, 22rem), 1fr))` }}
        >
          {columns.map(({ variant, run }) => (
            <div key={variant.id} className="flex snap-start items-center gap-2 border-b border-line pb-2 text-sm font-medium" data-output-column={nameOf(variant.id).text}>
              {blind ? null : <AgentIcon agent={variantAgent(variant)} size={14} />}
              <span className="min-w-0 truncate">{nameOf(variant.id).label}</span>
              {run && isOpenRun(run) ? <span className="text-xs font-normal text-ink-faint">{t('benchmark.outputs.pending')}</span> : null}
            </div>
          ))}

          <RowLabel>{t('benchmark.outputs.response')}</RowLabel>
          {columns.map(({ variant, run }) => (
            <Cell key={variant.id}>
              {run?.response ? (
                <div className="max-h-96 overflow-y-auto text-sm"><Markdown text={run.response} /></div>
              ) : (
                <Missing />
              )}
            </Cell>
          ))}

          <RowLabel>{t('benchmark.rating.title')}</RowLabel>
          {columns.map(({ variant, run }) => (
            <Cell key={variant.id}>
              {run && !isOpenRun(run) ? (
                <RatingInput benchmarkId={benchmark.id} run={run} label={t('benchmark.rating.of', { name: nameOf(variant.id).text })} />
              ) : (
                <Missing />
              )}
            </Cell>
          ))}

          {outputRows.map((row) => (
            <Fragment key={`${row.kind}-${row.index}`}>
              <RowLabel>{t(OUTPUT_KIND_LABELS[row.kind])}{row.index > 0 ? ` · ${row.index + 1}` : ''}</RowLabel>
              {columns.map(({ variant, run }, index) => {
                const file = row.files[index]
                return (
                  <Cell key={variant.id}>
                    {file && run?.previewToken ? <>
                      <p className="mb-2 truncate font-mono text-xs text-ink-soft" title={file.path}>{file.path}</p>
                      <Deliverable file={file} token={run.previewToken} />
                    </> : <Missing />}
                  </Cell>
                )
              })}
            </Fragment>
          ))}
        </div>
      </div>
      {outputRows.length === 0 && columns.every(({ run }) => run && !isOpenRun(run)) ? (
        <p className="text-xs text-ink-faint">{t('benchmark.outputs.noFiles')}</p>
      ) : null}
    </div>
  )
}

/** A label spanning the whole row: paths are long, and columns are for content. */
function RowLabel({ children }: { children: React.ReactNode }) {
  return <div className="col-span-full mt-2 truncate text-xs text-ink-faint">{children}</div>
}

function Cell({ children }: { children: React.ReactNode }) {
  return <div className="snap-start min-w-0 rounded-lg border border-line bg-surface p-2">{children}</div>
}

function Missing() {
  return <p className="py-6 text-center text-xs text-ink-faint">—</p>
}

function Deliverable({ file, token }: { file: BenchmarkDeliverable; token: string }) {
  const t = useTranslate()
  const url = benchmarkPreviewUrl(token, file.path)
  const name = file.path.split('/').pop() ?? file.path
  const actions = (
    <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-ink-faint">
      <span className="tabular-nums">{formatBytes(file.sizeBytes)}</span>
      <span className="flex items-center gap-3">
        {file.kind !== 'other' ? (
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
            <ExternalLink size={12} />{t('benchmark.outputs.open')}
          </a>
        ) : null}
        <a href={`${url}?download=1`} className="inline-flex items-center gap-1 hover:text-ink">
          <Download size={12} />{t('benchmark.outputs.download')}
        </a>
      </span>
    </div>
  )

  switch (file.kind) {
    case 'page':
      // Sandboxed twice: by this attribute and by the policy the route sends with the page.
      return <>
        <iframe
          title={file.path}
          src={url}
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          referrerPolicy="no-referrer"
          className="h-80 w-full rounded border border-line bg-white"
        />
        {actions}
      </>
    case 'image':
      return <><img src={url} alt={name} loading="lazy" className="max-h-80 w-full rounded object-contain" />{actions}</>
    case 'video':
      return <><video controls preload="metadata" src={url} className="max-h-80 w-full rounded bg-black" />{actions}</>
    case 'audio':
      return <><audio controls preload="metadata" src={url} className="w-full" />{actions}</>
    case 'pdf':
      return <><iframe title={file.path} src={url} className="h-80 w-full rounded border border-line" />{actions}</>
    case 'text':
      return <><TextPreview url={url} />{actions}</>
    default:
      return <><p className="py-4 text-center text-xs text-ink-soft">{name}</p>{actions}</>
  }
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
  if (isError) return <Missing />
  return (
    <pre className={cx('max-h-80 overflow-auto rounded bg-sunken p-2 font-mono text-xs whitespace-pre-wrap text-ink-soft', data === undefined && 'animate-pulse')}>
      {data ?? ' '}
    </pre>
  )
}
