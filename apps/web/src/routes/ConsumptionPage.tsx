import type { ConsumptionAmount, ConsumptionReport } from '@sillage/protocol'
import { conversationPath } from '@sillage/protocol'
import { ChartColumn, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { ConsumptionChart, Swatch, type ChartMetric } from '../components/consumption/ConsumptionChart'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Banner, Button, Card, EmptyState, Segmented, Select, Tabs } from '../components/ui'
import { CONSUMPTION_PERIODS, PERIOD_LABELS, formatCount, formatUsd, totalTokens, useConsumption, useRefreshPrices, type ConsumptionPeriod } from '../lib/consumption'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { useCurrentUser } from '../lib/session'
import '../styles/consumption.css'

type Breakdown = 'agents' | 'models' | 'projects' | 'accounts' | 'conversations'

const BREAKDOWN_LABELS: Record<Breakdown, MessageKey> = {
  agents: 'consumption.by.agents',
  models: 'consumption.by.models',
  projects: 'consumption.by.projects',
  accounts: 'consumption.by.accounts',
  conversations: 'consumption.by.conversations',
}

/**
 * What the instance consumes and what it would cost at public API prices. A tool page like
 * Services: it keeps the full width and its own controls, a period above everything and one
 * breakdown at a time below the chart.
 */
export function ConsumptionPage() {
  const t = useTranslate()
  const lang = locale()
  const { data: user } = useCurrentUser()
  const [params, setParams] = useSearchParams()
  const asked = params.get('period') as ConsumptionPeriod | null
  const period = asked && CONSUMPTION_PERIODS.includes(asked) ? asked : '30d'
  const [metric, setMetric] = useState<ChartMetric>('cost')
  const [breakdown, setBreakdown] = useState<Breakdown>('agents')
  const query = useConsumption(period)
  const refresh = useRefreshPrices()
  const report = query.data
  const periods = CONSUMPTION_PERIODS.map((value) => ({ value, label: t(PERIOD_LABELS[value]), text: t(PERIOD_LABELS[value]) }))
  const setPeriod = (value: ConsumptionPeriod) => setParams(value === '30d' ? {} : { period: value }, { replace: true })

  // One account, as on a desktop install, has nothing to compare.
  const breakdowns = (Object.keys(BREAKDOWN_LABELS) as Breakdown[]).filter((key) => key !== 'accounts' || (report?.accounts.length ?? 0) > 1)
  const current = breakdowns.includes(breakdown) ? breakdown : 'agents'
  const unpriced = report?.models.filter((row) => row.price === null) ?? []
  const prices = refresh.data ?? report?.prices

  return (
    <div className="flex h-full min-h-0 flex-col" data-consumption-page>
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 md:px-6">
        <MobileNavigationButton />
        <ChartColumn size={19} className="shrink-0 text-ink-faint" />
        <h1 className="text-base font-semibold">{t('consumption.title')}</h1>
        <div className="ml-auto">
          {/* Five choices do not fit a phone header beside the title. */}
          <div className="hidden md:block"><Segmented label={t('consumption.period.label')} value={period} onChange={setPeriod} options={periods} /></div>
          <Select className="w-36 md:hidden" placeholder={t('consumption.period.label')} value={period} onChange={setPeriod} options={periods} />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          {query.error ? <Banner>{t('consumption.loadError')} {query.error.message}</Banner> : null}
          {report && !report.historyReady ? <Banner tone="info">{t('consumption.history.reading')}</Banner> : null}
          {query.isPending ? <p role="status" className="text-sm text-ink-faint">{t('consumption.loading')}</p>
            : report && totalTokens(report.total) === 0 ? <EmptyState icon={<ChartColumn size={22} />} title={t('consumption.empty')} description={t('consumption.emptyHint')} />
              : report ? (
                <>
                  <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Tile label={t('consumption.tile.cost')} value={formatUsd(report.total.costUsd, lang)} detail={t('consumption.tile.cost.detail')} hero />
                    <Tile label={t('consumption.tile.tokens')} value={formatCount(totalTokens(report.total), lang)}
                      detail={t('consumption.tile.tokens.detail', { percent: Math.round((report.total.cacheReadTokens / totalTokens(report.total)) * 100) })} />
                    <Tile label={t('consumption.tile.output')} value={formatCount(report.total.outputTokens, lang)} detail={t('consumption.tile.output.detail', { input: formatCount(report.total.inputTokens, lang) })} />
                    <Tile label={t('consumption.tile.sessions')} value={report.sessions.toLocaleString(lang)}
                      detail={report.sessions ? t('consumption.tile.sessions.detail', { cost: formatUsd(report.total.costUsd / report.sessions, lang) }) : ''} />
                  </dl>

                  <Card className="p-4 md:p-5">
                    <div className="mb-4 flex items-center gap-3">
                      <h2 className="text-sm font-semibold">{t(report.bucket === 'month' ? 'consumption.chart.byMonth' : 'consumption.chart.byDay')}</h2>
                      <Segmented className="ml-auto" label={t('consumption.metric.label')} value={metric} onChange={setMetric}
                        options={[{ value: 'cost', label: t('consumption.metric.cost'), text: t('consumption.metric.cost') }, { value: 'tokens', label: t('consumption.metric.tokens'), text: t('consumption.metric.tokens') }]} />
                    </div>
                    <ConsumptionChart series={report.series} metric={metric} />
                  </Card>

                  {unpriced.length ? (
                    <Banner tone="info">{t('consumption.unpriced', { models: unpriced.map((row) => row.model || t('consumption.model.unknown')).join(', ') })}</Banner>
                  ) : null}

                  <Tabs label={t('consumption.by.label')} value={current} onChange={setBreakdown} tabs={breakdowns.map((value) => ({ value, label: t(BREAKDOWN_LABELS[value]) }))}>
                    <BreakdownTable report={report} breakdown={current} />
                  </Tabs>
                </>
              ) : null}

          {prices ? (
            <footer className="flex flex-col gap-2 border-t border-line pt-4 text-xs leading-relaxed text-ink-faint">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="max-w-2xl" data-consumption-prices={prices.origin}>
                  {t(prices.origin === 'bundled' ? 'consumption.prices.bundled' : 'consumption.prices.online', { date: new Date(prices.updatedAt).toLocaleDateString(lang, { dateStyle: 'long' }) })}
                  {prices.checkedAt ? ` ${t('consumption.prices.checked', { date: new Date(prices.checkedAt).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) })}` : ''}
                </p>
                {user?.isAdmin ? (
                  <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} busy={refresh.isPending} onClick={() => refresh.mutate()}>{t('consumption.prices.refresh')}</Button>
                ) : null}
              </div>
              {refresh.error ? <p className="text-critical">{refresh.error.message}</p> : null}
              {prices.error ? <p className="text-caution">{t(prices.error === 'invalid' ? 'consumption.prices.error.invalid' : 'consumption.prices.error.network')}</p> : null}
              <details>
                <summary className="w-fit cursor-pointer hover:text-ink">{t('consumption.method.title')}</summary>
                <p className="mt-2 max-w-2xl">{t('consumption.method')}</p>
              </details>
            </footer>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Tile({ label, value, detail, hero }: { label: string; value: string; detail: string; hero?: boolean }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className={hero ? 'text-2xl font-semibold tabular-nums text-ink' : 'text-2xl font-semibold tabular-nums text-ink-soft'}>{value}</dd>
      <dd className="text-xs text-ink-faint">{detail}</dd>
    </Card>
  )
}

interface Row extends ConsumptionAmount { key: string; name: ReactNode; detail?: ReactNode; unpriced?: boolean }

function BreakdownTable({ report, breakdown }: { report: ConsumptionReport; breakdown: Breakdown }) {
  const t = useTranslate()
  const lang = locale()
  const rate = (value: number) => formatUsd(value, lang)

  const rows: Row[] = breakdown === 'agents'
    ? report.agents.map((row) => ({ ...row, key: row.agent, name: <span className="flex items-center gap-2"><Swatch agent={row.agent} /><AgentIcon agent={row.agent} size={15} />{AGENT_LABELS[row.agent]}</span> }))
    : breakdown === 'models'
      ? report.models.map((row) => ({
          ...row,
          key: `${row.agent}:${row.model}`,
          name: <span className="flex items-center gap-2"><AgentIcon agent={row.agent} size={15} /><span className="truncate">{row.model || t('consumption.model.unknown')}</span></span>,
          detail: row.price ? t('consumption.model.rates', { input: rate(row.price.input), output: rate(row.price.output) }) : t('consumption.model.unpriced'),
          unpriced: row.price === null,
        }))
      : breakdown === 'projects'
        ? report.projects.map((row) => ({
            ...row,
            key: row.projectId ?? '',
            name: row.projectId === null ? t('consumption.project.none')
              : row.name === null ? <span className="text-ink-faint">{t('consumption.project.deleted')}</span>
                : <Link to={`/p/${row.projectId}`} className="hover:text-accent hover:underline">{row.name}</Link>,
          }))
        : breakdown === 'accounts'
          ? report.accounts.map((row) => ({ ...row, key: row.userId, name: row.name ?? <span className="text-ink-faint">{t('consumption.account.deleted')}</span> }))
          : report.conversations.map((row) => ({
              ...row,
              key: row.conversationId,
              name: <span className="flex min-w-0 items-center gap-2"><AgentIcon agent={row.agent} size={15} />
                {row.title === null ? <span className="text-ink-faint">{t('consumption.conversation.deleted')}</span>
                  : <Link to={conversationPath({ id: row.conversationId, projectId: row.projectId })} className="truncate hover:text-accent hover:underline">{row.title}</Link>}
              </span>,
            }))

  const top = Math.max(0, ...rows.map((row) => row.costUsd))
  const numeric = 'px-2 py-2.5 text-right tabular-nums whitespace-nowrap'
  const detail = `${numeric} hidden text-ink-soft md:table-cell`

  return (
    <div className="flex flex-col gap-2" data-consumption-breakdown={breakdown}>
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-ink-faint">
            <th scope="col" className="py-2 pr-2 text-left font-normal">{t(BREAKDOWN_LABELS[breakdown])}</th>
            <th scope="col" className={`${detail} w-20 font-normal`}>{t('consumption.col.input')}</th>
            <th scope="col" className={`${detail} w-20 font-normal`}>{t('consumption.col.output')}</th>
            <th scope="col" className={`${detail} w-24 font-normal`}>{t('consumption.col.cacheRead')}</th>
            <th scope="col" className={`${detail} w-24 font-normal`}>{t('consumption.col.cacheWrite')}</th>
            <th scope="col" className={`${numeric} w-20 font-normal md:hidden`}>{t('consumption.col.tokens')}</th>
            <th scope="col" className={`${numeric} w-24 font-normal`}>{t('consumption.col.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-line align-top">
              <th scope="row" className="min-w-0 py-2.5 pr-2 text-left font-normal">
                <div className="truncate text-ink">{row.name}</div>
                {row.detail ? <div className="mt-0.5 truncate text-xs text-ink-faint">{row.detail}</div> : null}
                {/* Share of the costliest row: where the money goes, at a glance down the column. */}
                <div aria-hidden className="mt-1.5 h-1 rounded-full bg-accent/70" style={{ width: top > 0 ? `max(2px, ${(row.costUsd / top) * 100}%)` : 0 }} />
              </th>
              <td className={detail}>{formatCount(row.inputTokens, lang)}</td>
              <td className={detail}>{formatCount(row.outputTokens, lang)}</td>
              <td className={detail}>{formatCount(row.cacheReadTokens, lang)}</td>
              <td className={detail}>{formatCount(row.cacheWriteTokens, lang)}</td>
              <td className={`${numeric} text-ink-soft md:hidden`}>{formatCount(totalTokens(row), lang)}</td>
              <td className={`${numeric} font-medium text-ink`}>{row.unpriced ? <span className="font-normal text-ink-faint">—</span> : formatUsd(row.costUsd, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {breakdown === 'conversations' ? <p className="text-xs text-ink-faint">{t('consumption.conversations.hint', { count: report.conversations.length })}</p> : null}
    </div>
  )
}
