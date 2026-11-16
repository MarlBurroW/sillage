import * as Dialog from '@radix-ui/react-dialog'
import { Check, CircleSlash, Copy, Download, ExternalLink, Files, Link2, MonitorPlay, Share2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  MAX_BENCHMARK_SHARE_NOTE_CHARS,
  variantAgent,
  type BenchmarkDto,
  type BenchmarkExportBlocker,
  type BenchmarkRunExportability,
  type BenchmarkShareDto,
  type BenchmarkShareOptions,
} from '@sillage/protocol'
import { formatBytes } from '../../lib/attachments'
import { benchmarkArchiveUrl, useBenchmarkShare, usePublishBenchmarkShare, useRevokeBenchmarkShare } from '../../lib/benchmarks'
import { useCopy } from '../../lib/clipboard'
import { locale, useTranslate, type MessageKey } from '../../lib/i18n'
import { useCapability } from '../../lib/instance'
import { AgentIcon } from '../AgentIcon'
import { Banner, Button, ConfirmDialog, Field, IconButton, Select, Switch, Tabs, cx } from '../ui'

const BLOCKER_LABELS: Record<BenchmarkExportBlocker, MessageKey> = {
  build: 'benchmark.share.blocked.build',
  server: 'benchmark.share.blocked.server',
  empty: 'benchmark.share.blocked.empty',
  missing: 'benchmark.share.blocked.missing',
  too_large: 'benchmark.share.blocked.tooLarge',
  unfinished: 'benchmark.share.blocked.unfinished',
}

type Expiry = '7' | '30' | 'never'

/**
 * Turns a benchmark into a page for people who do not have Sillage: what each variant built, live
 * when it is made of plain files, with the numbers beside it. The same page leaves as a public
 * link where the instance has a public address, and as a zip everywhere.
 */
export default function BenchmarkShareDialog({ benchmark, onClose }: { benchmark: BenchmarkDto; onClose: () => void }) {
  const t = useTranslate()
  const publicSharing = useCapability('publicConversationSharing')
  const state = useBenchmarkShare(benchmark.id, true)
  const publish = usePublishBenchmarkShare(benchmark.id)
  const [tab, setTab] = useState<'page' | 'links'>('page')
  const [expiry, setExpiry] = useState<Expiry>('30')
  const [published, setPublished] = useState<BenchmarkShareDto | null>(null)
  const [options, setOptions] = useState<BenchmarkShareOptions>({
    title: benchmark.name,
    note: '',
    includePrompt: true,
    includeResponses: true,
    includeMetrics: true,
    includeRatings: false,
    blind: false,
    locale: locale().startsWith('fr') ? 'fr' : 'en',
  })
  const set = (change: Partial<BenchmarkShareOptions>) => { setOptions((current) => ({ ...current, ...change })); setPublished(null) }

  const runs = state.data?.runs ?? []
  const live = runs.filter((run) => run.mode === 'page').length
  const shown = runs.filter((run) => run.mode !== 'none').length
  const rated = benchmark.runs.some((run) => run.rating !== null)
  const ready = options.title.trim().length > 0 && !!state.data
  const canPublish = publicSharing && !!state.data?.canPublish
  const links = state.data?.shares ?? []

  const page = (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Field label={t('benchmark.share.title')} value={options.title} onChange={(event) => set({ title: event.target.value })} />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-soft">{t('benchmark.share.note')}</span>
          <textarea
            rows={3}
            maxLength={MAX_BENCHMARK_SHARE_NOTE_CHARS}
            value={options.note}
            placeholder={t('benchmark.share.notePlaceholder')}
            onChange={(event) => set({ note: event.target.value })}
            className="rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
          />
        </label>
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
          <Option label={t('benchmark.share.option.prompt')} checked={options.includePrompt} onChange={(includePrompt) => set({ includePrompt })} />
          <Option label={t('benchmark.share.option.responses')} checked={options.includeResponses} onChange={(includeResponses) => set({ includeResponses })} />
          <Option label={t('benchmark.share.option.metrics')} hint={t('benchmark.share.option.metricsHint')} checked={options.includeMetrics} onChange={(includeMetrics) => set({ includeMetrics })} />
          {rated ? <Option label={t('benchmark.share.option.ratings')} checked={options.includeRatings} onChange={(includeRatings) => set({ includeRatings })} /> : null}
          <Option label={t('benchmark.share.option.blind')} hint={t('benchmark.share.option.blindHint')} checked={options.blind} onChange={(blind) => set({ blind })} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-medium text-ink-soft">{t('benchmark.share.contents')}</h3>
        {state.isPending ? <p role="status" className="text-sm text-ink-faint">{t('benchmark.share.checking')}</p>
          : state.isError ? <Banner>{state.error.message}</Banner>
          : <>
            <p className="text-xs text-ink-faint" data-share-summary>
              {t('benchmark.share.summary', { live, total: runs.length })}
              {shown > live ? ` ${t('benchmark.share.summary.files', { count: shown - live })}` : ''}
              {runs.length > shown ? ` ${t('benchmark.share.summary.rest')}` : ''}
            </p>
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" data-share-runs>
              {benchmark.variants.flatMap((variant) => benchmark.runs
                .filter((run) => run.variantId === variant.id)
                .sort((a, b) => a.repetition - b.repetition)
                .map((run) => {
                  const verdict = runs.find((entry) => entry.runId === run.id)
                  return (
                    <li key={run.id} className="flex items-start gap-2.5 px-3 py-2.5" data-share-run={verdict?.mode ?? 'none'}>
                      <span className="mt-0.5 shrink-0"><AgentIcon agent={variantAgent(variant)} size={15} /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          {variant.label}
                          {benchmark.repetitions > 1 ? <span className="text-ink-faint"> · {t('benchmark.table.repetition', { n: run.repetition })}</span> : null}
                        </p>
                        <Verdict verdict={verdict} />
                      </div>
                    </li>
                  )
                }))}
            </ul>
            <p className="text-xs leading-relaxed text-ink-faint">{t('benchmark.share.detection')}</p>
          </>}
      </div>
    </div>
  )

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby="benchmark-share-description"
          className="surface fixed inset-0 top-[var(--sg-window-bar,0px)] z-50 flex min-h-0 flex-col overflow-clip border-line shadow-pop sm:inset-x-[max(1.25rem,calc((100vw-1040px)/2))] sm:inset-y-6 sm:top-[calc(1.5rem+var(--sg-window-bar,0px))] sm:rounded-lg sm:border"
          data-benchmark-share
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold"><Share2 size={18} className="text-accent" />{t('benchmark.share')}</Dialog.Title>
              <Dialog.Description id="benchmark-share-description" className="mt-1 text-sm text-ink-faint">{t('benchmark.share.description')}</Dialog.Description>
            </div>
            <Dialog.Close asChild><IconButton label={t('common.close')}><X size={19} /></IconButton></Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            {publicSharing ? (
              <Tabs label={t('benchmark.share')} value={tab} onChange={setTab} tabs={[
                { value: 'page', label: t('benchmark.share.tab.page') },
                { value: 'links', label: t('benchmark.share.tab.links', { count: links.length }) },
              ]}>
                {tab === 'page' ? page : <Links benchmarkId={benchmark.id} links={links} pending={state.isPending} />}
              </Tabs>
            ) : page}
          </div>

          {tab === 'page' ? (
            <div className="flex shrink-0 flex-col gap-3 border-t border-line px-4 py-3 sm:px-6">
              {publish.error ? <Banner>{publish.error.message}</Banner> : null}
              {published?.url ? <PublishedLink url={published.url} /> : null}
              {publicSharing && state.data && !state.data.canPublish ? <Banner tone="info">{t('benchmark.share.needsAddress')}</Banner> : null}
              <div className="flex flex-wrap items-end justify-end gap-2">
                <p className="mr-auto min-w-0 flex-1 basis-56 text-xs leading-relaxed text-ink-faint">
                  {t(publicSharing ? 'benchmark.share.archiveHint' : 'benchmark.share.archiveOnly')}
                </p>
                {/* A plain link: the browser streams the archive to disk without holding it in memory. */}
                <a
                  href={ready ? benchmarkArchiveUrl(benchmark.id, { ...options, title: options.title.trim() }) : undefined}
                  aria-disabled={!ready}
                  className={cx(
                    'surface inline-flex h-11 items-center justify-center gap-1.5 rounded-md border border-line px-3 text-sm font-medium whitespace-nowrap text-ink transition-colors hover:border-line-strong md:h-9 pointer-coarse:h-11',
                    !ready && 'pointer-events-none opacity-45',
                    !canPublish && 'gradient-accent border-transparent text-accent-ink shadow-card hover:brightness-110',
                  )}
                  data-share-archive
                >
                  <Download size={15} />{t('benchmark.share.archive')}
                </a>
                {canPublish ? <>
                  <Select
                    className="w-40"
                    value={expiry}
                    onChange={setExpiry}
                    options={[
                      { value: '7', label: t('benchmark.share.expiry.7') },
                      { value: '30', label: t('export.expiry.30') },
                      { value: 'never', label: t('export.expiry.never') },
                    ]}
                  />
                  <Button
                    size="sm"
                    icon={<Link2 size={15} />}
                    busy={publish.isPending}
                    disabled={!ready || shown === 0}
                    onClick={() => publish.mutate(
                      { ...options, title: options.title.trim(), expiresAt: expiry === 'never' ? null : Date.now() + Number(expiry) * 86_400_000 },
                      { onSuccess: setPublished },
                    )}
                  >
                    {t('benchmark.share.publish')}
                  </Button>
                </> : null}
              </div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Option({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {hint ? <p className="text-xs leading-relaxed text-ink-faint">{hint}</p> : null}
      </div>
      <Switch label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** Why a run is shown the way it is: the answer to “will my friends see the page?”. */
function Verdict({ verdict }: { verdict: BenchmarkRunExportability | undefined }) {
  const t = useTranslate()
  const line = (tone: string, icon: ReactNode, text: ReactNode) => (
    <p className={cx('mt-0.5 flex items-start gap-1.5 text-xs leading-relaxed', tone)}><span className="mt-0.5 shrink-0">{icon}</span><span className="min-w-0">{text}</span></p>
  )
  if (!verdict || verdict.mode === 'none') {
    return line('text-ink-faint', <CircleSlash size={12} />, t(BLOCKER_LABELS[verdict?.reason ?? 'missing']))
  }
  const size = t('benchmark.share.size', { files: verdict.files, size: formatBytes(verdict.bytes) })
  return verdict.mode === 'page'
    ? line('text-positive', <MonitorPlay size={12} />, <>{t('benchmark.share.mode.page')} <span className="font-mono text-ink-faint">{verdict.entry}</span> <span className="text-ink-faint">· {size}</span></>)
    : line('text-ink-soft', <Files size={12} />, <>{t('benchmark.share.mode.files')} <span className="text-ink-faint">· {size}</span></>)
}

function PublishedLink({ url }: { url: string }) {
  const t = useTranslate()
  const copy = useCopy()
  return (
    <div className="flex items-center gap-2 rounded-md border border-positive/35 bg-positive/10 py-1 pr-1 pl-3" role="status" data-share-published>
      <Check size={15} className="shrink-0 text-positive" />
      <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-ink hover:underline">{url}</a>
      <IconButton size="sm" label={t(copy.state === 'copied' ? 'export.copied' : 'export.copy')} onClick={() => copy.copy(url)}>
        {copy.state === 'copied' ? <Check size={15} /> : <Copy size={15} />}
      </IconButton>
      <a href={url} target="_blank" rel="noreferrer"><IconButton size="sm" label={t('benchmark.outputs.open')} tabIndex={-1}><ExternalLink size={15} /></IconButton></a>
    </div>
  )
}

function Links({ benchmarkId, links, pending }: { benchmarkId: string; links: BenchmarkShareDto[]; pending: boolean }) {
  const t = useTranslate()
  const revoke = useRevokeBenchmarkShare(benchmarkId)
  const [removing, setRemoving] = useState<BenchmarkShareDto | null>(null)
  if (pending) return <p role="status" className="text-sm text-ink-faint">{t('benchmark.share.checking')}</p>
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-ink-faint">{t('benchmark.share.links.hint')}</p>
      {revoke.error ? <Banner>{revoke.error.message}</Banner> : null}
      {links.length === 0 ? <p className="py-10 text-center text-sm text-ink-faint">{t('benchmark.share.links.none')}</p> : (
        <ul className="divide-y divide-line" data-share-links>
          {links.map((link) => <LinkRow key={link.id} link={link} onRevoke={() => setRemoving(link)} />)}
        </ul>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => { if (!open) setRemoving(null) }}
        title={t('export.revoke.title')}
        confirmLabel={t('export.revoke')}
        tone="critical"
        busy={revoke.isPending}
        onConfirm={() => removing && revoke.mutate(removing.id, { onSuccess: () => setRemoving(null) })}
      >
        {t('benchmark.share.links.revoke')}
      </ConfirmDialog>
    </div>
  )
}

function LinkRow({ link, onRevoke }: { link: BenchmarkShareDto; onRevoke: () => void }) {
  const t = useTranslate()
  const copy = useCopy()
  const lang = locale()
  return (
    <li className="flex flex-wrap items-center gap-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{link.title}</p>
        {link.url ? <a href={link.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-accent hover:underline">{link.url}</a> : null}
        <p className="mt-0.5 text-xs text-ink-faint">
          {t('export.links.created', { date: new Date(link.createdAt).toLocaleDateString(lang) })} · {t('export.expiry')}: {link.expiresAt ? new Date(link.expiresAt).toLocaleDateString(lang) : t('export.expiry.never')}
        </p>
      </div>
      {link.url ? (
        <IconButton label={t(copy.state === 'copied' ? 'export.copied' : 'export.copy')} onClick={() => copy.copy(link.url!)}>
          {copy.state === 'copied' ? <Check size={16} /> : <Copy size={16} />}
        </IconButton>
      ) : null}
      <Button variant="danger" size="sm" onClick={onRevoke}>{t('export.revoke')}</Button>
    </li>
  )
}
