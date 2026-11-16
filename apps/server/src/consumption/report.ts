import { and, gte, inArray, lt, min, sql } from 'drizzle-orm'
import { conversations, projects, turnUsage, users, type Db } from '@sillage/db'
import type { AgentKind, ConsumptionAmount, ConsumptionBucket, ConsumptionReport } from '@sillage/protocol'
import type { PriceCatalog } from '../pricing/catalog.js'
import { costOf, type TokenCounts } from '../pricing/prices.js'

const DAY = 24 * 60 * 60 * 1000
/** Fine enough for every time zone offset in use, quarter hours included. */
const SLOT = 15 * 60 * 1000
/** Beyond this, one bar per day no longer reads: months take over. */
const DAILY_LIMIT = 92 * DAY
const TOP_CONVERSATIONS = 50

const empty = (): ConsumptionAmount => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })

function add(into: ConsumptionAmount, tokens: TokenCounts, costUsd: number): void {
  into.inputTokens += tokens.inputTokens
  into.outputTokens += tokens.outputTokens
  into.cacheReadTokens += tokens.cacheReadTokens
  into.cacheWriteTokens += tokens.cacheWriteTokens + tokens.cacheWrite1hTokens
  into.costUsd += costUsd
}

const sums = {
  inputTokens: sql<number>`sum(${turnUsage.inputTokens})`,
  outputTokens: sql<number>`sum(${turnUsage.outputTokens})`,
  cacheReadTokens: sql<number>`sum(${turnUsage.cacheReadTokens})`,
  cacheWriteTokens: sql<number>`sum(${turnUsage.cacheWriteTokens})`,
  cacheWrite1hTokens: sql<number>`sum(${turnUsage.cacheWrite1hTokens})`,
}

const byCost = (a: ConsumptionAmount, b: ConsumptionAmount) => b.costUsd - a.costUsd || tokensOf(b) - tokensOf(a)
const tokensOf = (amount: ConsumptionAmount) => amount.inputTokens + amount.outputTokens + amount.cacheReadTokens + amount.cacheWriteTokens

/** Calendar dates as the reader's clock shows them: a turn at 23:30 in Paris is not tomorrow's. */
function calendar(timeZone: string, bucket: ConsumptionBucket): (ts: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (ts) => format.format(ts).slice(0, bucket === 'month' ? 7 : 10)
}

/**
 * Consumption between two instants, priced with the catalog as it stands now. Prices are linear
 * in tokens, so groups are summed in SQLite first and priced once per model.
 */
export function consumptionReport(db: Db, prices: PriceCatalog, range: { from: number | null; to: number; timeZone: string }, historyReady: boolean): ConsumptionReport {
  const first = range.from ?? db.select({ ts: min(turnUsage.ts) }).from(turnUsage).get()?.ts ?? range.to
  const from = Math.min(first, range.to)
  const bucket: ConsumptionBucket = range.to - from > DAILY_LIMIT ? 'month' : 'day'
  const dateOf = calendar(range.timeZone, bucket)
  const within = and(gte(turnUsage.ts, from), lt(turnUsage.ts, range.to))
  const priceOf = memo((model: string) => prices.priceOf(model))
  const priced = (model: string, tokens: TokenCounts) => {
    const price = priceOf(model)
    return price ? costOf(price, tokens) : 0
  }

  const slot = sql<number>`${turnUsage.ts} / ${SLOT}`
  const groups = db
    .select({ slot, agent: turnUsage.agent, model: turnUsage.model, projectId: turnUsage.projectId, userId: turnUsage.userId, ...sums })
    .from(turnUsage).where(within)
    .groupBy(slot, turnUsage.agent, turnUsage.model, turnUsage.projectId, turnUsage.userId)
    .all()

  const total = empty()
  const series = new Map<string, Map<AgentKind, ConsumptionAmount>>()
  // Every bucket exists before it is filled: a day without a turn is a gap in the chart, not a
  // missing bar. Half-day steps cannot skip a date across a clock change.
  for (let ts = from; ts < range.to; ts += DAY / 2) series.set(dateOf(ts), new Map())
  if (range.to > from) series.set(dateOf(range.to - 1), series.get(dateOf(range.to - 1)) ?? new Map())
  const agents = new Map<AgentKind, ConsumptionAmount>()
  const models = new Map<string, ConsumptionAmount & { model: string; agent: AgentKind }>()
  const byProject = new Map<string | null, ConsumptionAmount>()
  const byUser = new Map<string, ConsumptionAmount>()
  const slotOf = <K, V>(map: Map<K, V>, key: K, create: () => V): V => {
    let amount = map.get(key)
    if (!amount) map.set(key, amount = create())
    return amount
  }

  for (const group of groups) {
    const cost = priced(group.model, group)
    add(total, group, cost)
    add(slotOf(slotOf(series, dateOf(group.slot * SLOT), () => new Map<AgentKind, ConsumptionAmount>()), group.agent, empty), group, cost)
    add(slotOf(agents, group.agent, empty), group, cost)
    add(slotOf(models, `${group.agent}\n${group.model}`, () => ({ ...empty(), model: group.model, agent: group.agent })), group, cost)
    add(slotOf(byProject, group.projectId, empty), group, cost)
    add(slotOf(byUser, group.userId, empty), group, cost)
  }

  const perConversation = new Map<string, ConsumptionAmount & { conversationId: string; projectId: string | null; agent: AgentKind }>()
  const turns = db
    .select({ conversationId: turnUsage.conversationId, model: turnUsage.model, agent: turnUsage.agent, projectId: sql<string | null>`max(${turnUsage.projectId})`, ...sums })
    .from(turnUsage).where(within)
    .groupBy(turnUsage.conversationId, turnUsage.model)
    .all()
  for (const turn of turns) {
    add(slotOf(perConversation, turn.conversationId, () => ({ ...empty(), conversationId: turn.conversationId, projectId: turn.projectId, agent: turn.agent })), turn, priced(turn.model, turn))
  }
  const top = [...perConversation.values()].sort(byCost).slice(0, TOP_CONVERSATIONS)

  const projectIds = [...byProject.keys()].filter((id): id is string => id !== null)
  const projectNames = new Map(projectIds.length ? db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)).all().map((row) => [row.id, row.name]) : [])
  const userNames = new Map(byUser.size ? db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [...byUser.keys()])).all().map((row) => [row.id, row.name]) : [])
  const titles = new Map(top.length ? db.select({ id: conversations.id, title: conversations.title }).from(conversations).where(inArray(conversations.id, top.map((row) => row.conversationId))).all().map((row) => [row.id, row.title]) : [])

  return {
    from,
    to: range.to,
    bucket,
    total,
    sessions: perConversation.size,
    series: [...series].sort(([a], [b]) => a.localeCompare(b)).map(([date, perAgent]) => ({ date, agents: [...perAgent].map(([agent, amount]) => ({ agent, ...amount })) })),
    agents: [...agents].map(([agent, amount]) => ({ agent, ...amount })).sort(byCost),
    models: [...models.values()].map((row) => ({ ...row, price: priceOf(row.model) })).sort(byCost),
    projects: [...byProject].map(([projectId, amount]) => ({ projectId, name: projectId ? projectNames.get(projectId) ?? null : null, ...amount })).sort(byCost),
    accounts: [...byUser].map(([userId, amount]) => ({ userId, name: userNames.get(userId) ?? null, ...amount })).sort(byCost),
    conversations: top.map((row) => ({ ...row, title: titles.get(row.conversationId) ?? null })),
    prices: prices.status(),
    historyReady,
  }
}

function memo<K, V>(compute: (key: K) => V): (key: K) => V {
  const known = new Map<K, V>()
  return (key) => {
    if (!known.has(key)) known.set(key, compute(key))
    return known.get(key)!
  }
}
