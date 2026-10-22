import { ArrowUpRight, Check, Copy, FlaskConical, Loader, RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import type {
  AutomationDeliveryDto,
  AutomationEvent,
  AutomationTemplateId,
  DeliveryVerdict,
  WebhookTestResult,
} from '@sillage/protocol'
import { automationSamples } from '../../lib/automation-samples'
import { describeReason, parseHeaders, useReplayDelivery, useWebhookCurl } from '../../lib/automations'
import { useCopy } from '../../lib/clipboard'
import { relativeDate } from '../../lib/dates'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { Badge, Banner, Button, IconButton, Select, Switch, cx } from '../ui'
import { PayloadTree } from './PayloadTree'
import { ScriptEditor } from './ScriptEditor'

/** Editable bench call from an example or received delivery. */
export interface BenchCall {
  source: { kind: 'sample'; id: string } | { kind: 'delivery'; id: string }
  headersText: string
  body: string
  /** Manually edited since loading. */
  edited: boolean
  /** Received body exceeded log retention and is truncated. */
  truncated: boolean
}

type BadgeTone = 'neutral' | 'accent' | 'positive' | 'caution' | 'critical'

export const VERDICTS: Record<DeliveryVerdict, { label: MessageKey; tone: BadgeTone }> = {
  launched: { label: 'automation.verdict.launched', tone: 'positive' },
  queued: { label: 'automation.verdict.queued', tone: 'accent' },
  coalesced: { label: 'automation.verdict.coalesced', tone: 'neutral' },
  busy: { label: 'automation.verdict.busy', tone: 'neutral' },
  filtered: { label: 'automation.verdict.filtered', tone: 'neutral' },
  script_skipped: { label: 'automation.verdict.scriptSkipped', tone: 'neutral' },
  script_error: { label: 'automation.verdict.scriptError', tone: 'critical' },
  duplicate: { label: 'automation.verdict.duplicate', tone: 'neutral' },
  unauthorized: { label: 'automation.verdict.unauthorized', tone: 'critical' },
  chain_refused: { label: 'automation.verdict.chainRefused', tone: 'caution' },
  circuit_open: { label: 'automation.verdict.circuitOpen', tone: 'critical' },
  disabled: { label: 'automation.verdict.disabled', tone: 'neutral' },
  launch_failed: { label: 'automation.verdict.launchFailed', tone: 'critical' },
}

/**
 * Automation test bench beside configuration: load an example or real call, edit, and inspect
 * verdict/prompt/script after each setting change without launching work. The page owns navigation
 * to the received-call history, so it stays reachable without scrolling through configuration.
 */
export function TestBench({
  taskId,
  template,
  deliveries,
  call,
  onCall,
  onLoadSample,
  onLoadDelivery,
  loadingDelivery,
  event,
  result,
  pending,
  error,
  hasScript,
  onFilter,
  onInsert,
}: {
  taskId: string
  template: AutomationTemplateId | null
  deliveries: AutomationDeliveryDto[]
  call: BenchCall
  onCall: (call: BenchCall) => void
  onLoadSample: (id: string) => void
  onLoadDelivery: (id: string) => void
  loadingDelivery: boolean
  event: AutomationEvent
  result: WebhookTestResult | undefined
  pending: boolean
  error: Error | null
  hasScript: boolean
  onFilter: (path: string, value: unknown) => void
  onInsert: (path: string) => void
}) {
  const t = useTranslate()
  const received = deliveries.filter((row) => row.verdict !== 'unauthorized')

  return (
    <section className="surface flex min-w-0 flex-col rounded-lg border border-line shadow-card" aria-label={t('automation.bench.title')}>
      <h2 className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
        <FlaskConical size={15} />{t('automation.bench.title')}
      </h2>
      <Bench
        taskId={taskId}
        template={template}
        received={received}
        call={call}
        onCall={onCall}
        onLoadSample={onLoadSample}
        onLoadDelivery={onLoadDelivery}
        loadingDelivery={loadingDelivery}
        event={event}
        result={result}
        pending={pending}
        error={error}
        hasScript={hasScript}
        onFilter={onFilter}
        onInsert={onInsert}
      />
    </section>
  )
}

function SubTabs<T extends string>({ value, onChange, options }: { value: T; onChange: (value: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div role="tablist" className="flex gap-1 rounded-md border border-line bg-sunken p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx('min-h-8 flex-1 rounded px-2 text-xs transition-colors', value === option.value ? 'bg-surface-high font-medium text-ink' : 'text-ink-faint hover:text-ink-soft')}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// --- Test bench -------------------------------------------------------------------------

function Bench({
  taskId,
  template,
  received,
  call,
  onCall,
  onLoadSample,
  onLoadDelivery,
  loadingDelivery,
  event,
  result,
  pending,
  error,
  hasScript,
  onFilter,
  onInsert,
}: {
  taskId: string
  template: AutomationTemplateId | null
  received: AutomationDeliveryDto[]
  call: BenchCall
  onCall: (call: BenchCall) => void
  onLoadSample: (id: string) => void
  onLoadDelivery: (id: string) => void
  loadingDelivery: boolean
  event: AutomationEvent
  result: WebhookTestResult | undefined
  pending: boolean
  error: Error | null
  hasScript: boolean
  onFilter: (path: string, value: unknown) => void
  onInsert: (path: string) => void
}) {
  const t = useTranslate()
  const [view, setView] = useState<'prompt' | 'call' | 'script'>('prompt')
  const samples = automationSamples()
  const relevant = samples.filter((sample) => template && sample.templates.includes(template))
  const others = samples.filter((sample) => !template || !sample.templates.includes(template))

  const sourceValue = call.source.kind === 'sample' ? `sample:${call.source.id}` : `delivery:${call.source.id}`
  const options = [
    ...received.slice(0, 15).map((row) => ({
      value: `delivery:${row.id}`,
      label: t('automation.bench.received', { summary: row.summary ?? t('automation.deliveries.unnamed'), when: relativeDate(row.receivedAt) }),
    })),
    ...[...relevant, ...others].map((sample) => ({ value: `sample:${sample.id}`, label: t('automation.bench.example', { name: t(sample.label) }) })),
  ]

  const choose = (value: string) => {
    const [kind, id] = value.split(':') as ['sample' | 'delivery', string]
    if (kind === 'sample') onLoadSample(id)
    else onLoadDelivery(id)
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <p className="text-xs text-ink-faint">{t('automation.bench.description')}</p>

      <div className="flex flex-col gap-1.5">
        <Select label={t('automation.bench.call')} value={sourceValue} onChange={choose} options={options} />
        {call.edited ? (
          <p className="flex items-center gap-1.5 text-xs text-ink-faint">
            {t('automation.bench.edited')}
            <button type="button" className="text-accent hover:underline" onClick={() => choose(sourceValue)}>
              {t('automation.bench.reset')}
            </button>
          </p>
        ) : null}
        {loadingDelivery ? <p className="text-xs text-ink-faint">{t('schedule.loading')}</p> : null}
      </div>

      <BenchVerdict result={result} pending={pending} error={error} />

      <SubTabs
        value={view}
        onChange={setView}
        options={[
          { value: 'prompt', label: t('automation.bench.tab.prompt') },
          { value: 'call', label: t('automation.bench.tab.call') },
          { value: 'script', label: t('automation.bench.tab.script') },
        ]}
      />

      {view === 'prompt' ? <PromptView result={result} /> : null}
      {view === 'call' ? <CallView taskId={taskId} call={call} onCall={onCall} event={event} onFilter={onFilter} onInsert={onInsert} /> : null}
      {view === 'script' ? <ScriptView result={result} hasScript={hasScript} /> : null}
    </div>
  )
}

/** Bench-call verdict and explanation. */
function BenchVerdict({ result, pending, error }: { result: WebhookTestResult | undefined; pending: boolean; error: Error | null }) {
  const t = useTranslate()
  if (error) return <Banner>{error.message}</Banner>
  if (!result) return <Banner tone="info">{t(pending ? 'automation.test.running' : 'automation.test.idle')}</Banner>
  const reason = result.reason ? describeReason(result.reason, t) : ''
  if (result.verdict === 'launch' && result.reason) return <Banner tone="caution">{t('automation.test.chainRefused', { reason })}</Banner>
  if (result.verdict === 'launch') {
    return (
      <Banner tone="positive">
        {result.subject ? t('automation.test.launchSubject', { subject: result.subject }) : t('automation.test.launch')}
      </Banner>
    )
  }
  // Script errors already explain themselves without extra prefixes.
  if (result.verdict === 'script_error') return <Banner>{reason}</Banner>
  return <Banner tone="info">{t('automation.test.ignored', { reason })}</Banner>
}

function PromptView({ result }: { result: WebhookTestResult | undefined }) {
  const t = useTranslate()
  const [full, setFull] = useState(false)
  if (!result) return null
  const missing = [...new Set([...result.prompt.matchAll(/\{\{\s*([\w.*-]+)\s*\}\}/g)].map((match) => match[1]!))]
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-faint">
          {t(result.verdict === 'launch' ? 'automation.bench.promptLaunch' : 'automation.bench.promptIgnored')}
        </p>
        <label className="flex shrink-0 items-center gap-2 text-xs text-ink-soft">
          {t('automation.bench.fullMessage')}
          <Switch checked={full} onCheckedChange={setFull} label={t('automation.bench.fullMessage')} />
        </label>
      </div>
      {missing.length > 0 ? <Banner tone="caution">{t('automation.prompt.missing', { paths: missing.join(', ') })}</Banner> : null}
      <pre className="max-h-[28rem] min-h-24 overflow-auto rounded-md border border-line bg-surface-high px-3 py-2 font-sans text-sm leading-relaxed whitespace-pre-wrap text-ink">
        {full ? result.message : result.prompt}
      </pre>
    </div>
  )
}

function CallView({
  taskId,
  call,
  onCall,
  event,
  onFilter,
  onInsert,
}: {
  taskId: string
  call: BenchCall
  onCall: (call: BenchCall) => void
  event: AutomationEvent
  onFilter: (path: string, value: unknown) => void
  onInsert: (path: string) => void
}) {
  const t = useTranslate()
  const headersId = useId()
  const [mode, setMode] = useState<'explore' | 'edit'>('explore')
  const [part, setPart] = useState<'payload' | 'headers'>('payload')
  const curl = useWebhookCurl(taskId)
  const curlCopy = useCopy()
  const { headers, invalid } = parseHeaders(call.headersText)
  const json = event.payload !== null || call.body.trim() === ''

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SubTabs
        value={mode}
        onChange={setMode}
        options={[
          { value: 'explore', label: t('automation.bench.view.explore') },
          { value: 'edit', label: t('automation.bench.view.edit') },
        ]}
      />
      {call.truncated ? <Banner tone="caution">{t('automation.sample.truncated')}</Banner> : null}

      {mode === 'explore' ? (
        <>
          <p className="text-xs text-ink-faint">{t('automation.bench.exploreHint')}</p>
          <SubTabs
            value={part}
            onChange={setPart}
            options={[
              { value: 'payload', label: t('automation.sample.payload') },
              { value: 'headers', label: t('automation.sample.headers') },
            ]}
          />
          <div className="max-h-[28rem] overflow-auto rounded-md border border-line px-1 py-1">
            {part === 'payload' ? (
              json ? <PayloadTree value={event.payload} root="payload" onFilter={onFilter} onInsert={onInsert} /> : <p className="px-2 py-2 text-xs text-caution">{t('automation.bench.notJson')}</p>
            ) : (
              <PayloadTree value={event.headers} root="headers" onFilter={onFilter} onInsert={onInsert} />
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={headersId} className="text-sm font-medium text-ink-soft">{t('automation.bench.headers')}</label>
            <textarea
              id={headersId}
              rows={3}
              spellCheck={false}
              value={call.headersText}
              onChange={(change) => onCall({ ...call, headersText: change.target.value, edited: true })}
              className="rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs text-ink outline-none transition-colors hover:border-line-strong focus:border-accent"
            />
            <p className="text-xs text-ink-faint">{t('automation.bench.headersHint')}</p>
            {invalid > 0 ? <p className="text-xs text-caution">{t('automation.bench.headersInvalid', { count: invalid })}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-soft">{t('automation.bench.body')}</span>
            {/* Remount for each loaded call because editor text is initial state. */}
            <ScriptEditor
              key={`${call.source.kind}:${call.source.id}`}
              value={call.body}
              onChange={(body) => onCall({ ...call, body, edited: true })}
              label={t('automation.bench.body')}
              language="payload.json"
              maxHeight="22rem"
            />
            {!json ? <p className="text-xs text-caution">{t('automation.bench.notJson')}</p> : null}
          </div>
        </>
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-xs text-ink-faint">{t('automation.bench.curlIntro')}</p>
          <Button
            size="sm"
            variant="secondary"
            icon={curlCopy.state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
            disabled={curl.isPending}
            onClick={() => curl.mutate({ headers, body: call.body }, { onSuccess: (data) => curlCopy.copy(data.command) })}
          >
            {t(curlCopy.state === 'copied' ? 'automation.bench.curlCopied' : 'automation.bench.curl')}
          </Button>
        </div>
        {curl.error ? <Banner>{curl.error.message}</Banner> : null}
        {curl.data ? (
          <pre className="max-h-40 overflow-auto rounded-md border border-line bg-surface-high px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-ink-soft">{curl.data.command}</pre>
        ) : null}
      </div>
    </div>
  )
}

function ScriptView({ result, hasScript }: { result: WebhookTestResult | undefined; hasScript: boolean }) {
  const t = useTranslate()
  if (!hasScript) return <p className="text-sm text-ink-faint">{t('automation.bench.noScript')}</p>
  if (!result?.script.ran) return <p className="text-sm text-ink-faint">{t('automation.bench.scriptNotRun')}</p>
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {result.script.error ? (
        <Banner>{describeReason(result.script.error, t)}</Banner>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-ink-faint">{t('automation.script.result', { ms: result.script.durationMs })}</p>
          <pre className="max-h-48 overflow-auto rounded-md border border-line bg-surface-high px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink-soft">
            {JSON.stringify(result.script.result, null, 2)}
          </pre>
          {Object.keys(result.vars).length > 0 ? (
            <p className="text-xs text-ink-faint">{t('automation.script.varsHint', { names: Object.keys(result.vars).map((name) => `{{vars.${name}}}`).join(', ') })}</p>
          ) : null}
        </div>
      )}
      {result.script.logs.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-ink-faint">{t('automation.script.logs')}</p>
          <pre className="max-h-40 overflow-auto rounded-md border border-line bg-surface-high px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink-soft">{result.script.logs.join('\n')}</pre>
        </div>
      ) : null}
    </div>
  )
}

// --- Log --------------------------------------------------------------------------------

export function AutomationJournal({
  taskId,
  projectId,
  deliveries,
  loading,
  onTry,
}: {
  taskId: string
  projectId: string
  deliveries: AutomationDeliveryDto[]
  loading: boolean
  onTry: (id: string) => void
}) {
  const t = useTranslate()
  const replay = useReplayDelivery(taskId)
  return (
    <div className="flex min-w-0 flex-col gap-2 p-2">
      <p className="px-2 pt-1 text-xs text-ink-faint">{t('automation.journal.description')}</p>
      {replay.error ? <Banner>{replay.error.message}</Banner> : null}
      {loading ? (
        <p className="px-2 py-2 text-sm text-ink-faint"><Loader size={12} className="mr-1 inline animate-spin" />{t('schedule.loading')}</p>
      ) : deliveries.length === 0 ? (
        <p className="px-2 py-3 text-sm text-ink-faint">{t('automation.journal.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {deliveries.map((row) => {
            const verdict = VERDICTS[row.verdict]
            const reason = row.reason ? describeReason(row.reason, t) : null
            return (
              <li key={row.id} className="flex items-center gap-1 rounded-md px-2 py-2 hover:bg-surface-high">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge tone={verdict.tone}>{t(verdict.label)}</Badge>
                    <span className="min-w-0 truncate text-sm text-ink">{row.summary ?? t('automation.deliveries.unnamed')}</span>
                    {row.subject ? <span className="text-xs text-ink-faint">#{row.subject}</span> : null}
                  </span>
                  <span className="flex min-w-0 gap-2 text-xs text-ink-faint">
                    <span className="shrink-0">{relativeDate(row.receivedAt)}</span>
                    {reason ? <span className="min-w-0 truncate" title={reason}>{reason}</span> : null}
                  </span>
                </div>
                {row.verdict !== 'unauthorized' ? (
                  <Button size="sm" variant="ghost" icon={<FlaskConical size={14} />} onClick={() => onTry(row.id)}>
                    {t('automation.journal.try')}
                  </Button>
                ) : null}
                {row.conversationId ? (
                  <Link
                    to={`/p/${projectId}/c/${row.conversationId}`}
                    className="grid size-9 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-surface hover:text-ink"
                    title={t('automation.deliveries.openSession')}
                    aria-label={t('automation.deliveries.openSession')}
                  >
                    <ArrowUpRight size={15} />
                  </Link>
                ) : null}
                {row.verdict !== 'unauthorized' ? (
                  <IconButton size="sm" label={t('automation.deliveries.replay')} disabled={replay.isPending} onClick={() => replay.mutate(row.id)}>
                    <RotateCcw size={14} />
                  </IconButton>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
