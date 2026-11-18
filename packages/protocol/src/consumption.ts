import { z } from 'zod'
import { agentKindSchema } from './events.js'

/**
 * Token consumption of the instance and what it would cost at public API prices.
 *
 * Distinct from `usage.ts`, the quota gauges of a CLI account: this counts what the turns
 * consumed, whoever pays for it. The cost is always an API equivalent computed from a public
 * price list, never an invoice: a subscription is not billed by the token.
 */

export const consumptionAmountSchema = z.object({
  /** Input processed outside the cache. */
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  /** Cache writes of every lifetime. */
  cacheWriteTokens: z.number(),
  /** Priced part only: tokens of a model missing from the price list add nothing here. */
  costUsd: z.number(),
})
export type ConsumptionAmount = z.infer<typeof consumptionAmountSchema>

/** Dollars per million tokens; a null rate is not listed and falls back on the input rate. */
export const modelPriceSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().nullable(),
  cacheWrite: z.number().nullable(),
  cacheWrite1h: z.number().nullable(),
})
/** A model's public list rates, as shown beside a model choice; never a charge on a subscription. */
export type ModelListPrice = z.infer<typeof modelPriceSchema>

export const priceCatalogStatusSchema = z.object({
  /** When the prices in use last changed. */
  updatedAt: z.number(),
  /** Last successful check of the source; null while the list shipped with the build is in use. */
  checkedAt: z.number().nullable(),
  origin: z.enum(['online', 'bundled']),
  /** Outcome of the last check: the previous list stays in use on failure. */
  error: z.enum(['network', 'invalid']).nullable(),
})
export type PriceCatalogStatus = z.infer<typeof priceCatalogStatusSchema>

export const consumptionBucketSchema = z.enum(['day', 'month'])
export type ConsumptionBucket = z.infer<typeof consumptionBucketSchema>

export const consumptionReportSchema = z.object({
  /** Range actually covered, in milliseconds; `from` is the first recorded turn when none was asked. */
  from: z.number(),
  to: z.number(),
  bucket: consumptionBucketSchema,
  total: consumptionAmountSchema,
  /** Conversations with at least one turn in the range. */
  sessions: z.number(),
  /** Every bucket of the range in order, empty ones included; `date` is `YYYY-MM-DD` or `YYYY-MM`. */
  series: z.array(z.object({
    date: z.string(),
    agents: z.array(consumptionAmountSchema.extend({ agent: agentKindSchema })),
  })),
  agents: z.array(consumptionAmountSchema.extend({ agent: agentKindSchema })),
  models: z.array(consumptionAmountSchema.extend({
    model: z.string(),
    agent: agentKindSchema,
    /** Null when no list knows the model: its tokens count, its cost does not. */
    price: modelPriceSchema.nullable(),
  })),
  projects: z.array(consumptionAmountSchema.extend({
    /** Null for discussions and benchmarks, held outside any project. */
    projectId: z.string().nullable(),
    /** Null once the project is deleted. */
    name: z.string().nullable(),
  })),
  accounts: z.array(consumptionAmountSchema.extend({ userId: z.string(), name: z.string().nullable() })),
  /** The costliest conversations of the range. */
  conversations: z.array(consumptionAmountSchema.extend({
    conversationId: z.string(),
    /** Null once the conversation is deleted. */
    title: z.string().nullable(),
    projectId: z.string().nullable(),
    agent: agentKindSchema,
  })),
  prices: priceCatalogStatusSchema,
  /** False until the turns that predate this dashboard have been read from the journals. */
  historyReady: z.boolean(),
})
export type ConsumptionReport = z.infer<typeof consumptionReportSchema>
