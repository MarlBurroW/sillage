import type { AgentKind, ConsumptionAmount, ConsumptionReport, PriceCatalogStatus } from '@sillage/protocol'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { Locale, MessageKey } from './i18n'

export const CONSUMPTION_PERIODS = ['7d', '30d', '90d', '12m', 'all'] as const
export type ConsumptionPeriod = typeof CONSUMPTION_PERIODS[number]

export const PERIOD_LABELS: Record<ConsumptionPeriod, MessageKey> = {
  '7d': 'consumption.period.7d',
  '30d': 'consumption.period.30d',
  '90d': 'consumption.period.90d',
  '12m': 'consumption.period.12m',
  all: 'consumption.period.all',
}

/**
 * Stacking and color order of the CLIs. Fixed: a CLI keeps its color whichever others consumed
 * during the period (`styles/consumption.css` holds the colors, validated in this order).
 */
export const SERIES_AGENTS: AgentKind[] = ['codex', 'claude', 'opencode', 'grok', 'antigravity']

/** Start of the period on the reader's calendar: whole days, today included; null for everything. */
export function periodStart(period: ConsumptionPeriod, now = new Date()): number | null {
  if (period === 'all') return null
  if (period === '12m') return new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (Number.parseInt(period, 10) - 1)).getTime()
}

const CONSUMPTION_KEY = ['consumption'] as const

export function useConsumption(period: ConsumptionPeriod) {
  return useQuery({
    queryKey: [...CONSUMPTION_KEY, period],
    queryFn: () => {
      const query = new URLSearchParams({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
      const from = periodStart(period)
      if (from !== null) query.set('from', String(from))
      return api.get<ConsumptionReport>(`/api/consumption?${query}`)
    },
    staleTime: 30_000,
    // Past sessions are read in the background after an update: follow them until they are in.
    refetchInterval: (query) => (query.state.data?.historyReady === false ? 3_000 : false),
  })
}

export function useRefreshPrices() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<PriceCatalogStatus>('/api/consumption/prices/refresh'),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: CONSUMPTION_KEY }) },
  })
}

export function totalTokens(amount: ConsumptionAmount): number {
  return amount.inputTokens + amount.outputTokens + amount.cacheReadTokens + amount.cacheWriteTokens
}

/** Whole dollars once the cents stop mattering, a third decimal below one dollar. */
export function formatUsd(value: number, locale: Locale): string {
  const digits = value >= 1000 ? 0 : value >= 1 || value === 0 ? 2 : 3
  return value.toLocaleString(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** Billions of cached tokens are routine here: compact notation in the reader's language. */
export function formatCount(value: number, locale: Locale): string {
  return value.toLocaleString(locale, { notation: 'compact', maximumFractionDigits: value < 1000 ? 0 : 1 })
}

/** A bucket's date as an axis or tooltip label; `date` is `YYYY-MM-DD` or `YYYY-MM`. */
export function formatBucket(date: string, locale: Locale, long = false): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(year!, (month ?? 1) - 1, day ?? 1)
  return day === undefined
    ? value.toLocaleDateString(locale, { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit' })
    : value.toLocaleDateString(locale, long ? { weekday: 'short', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' })
}
