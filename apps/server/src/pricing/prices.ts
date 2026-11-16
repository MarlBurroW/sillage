/**
 * Public API prices, reduced to what a coding session consumes.
 *
 * Two public lists are read. LiteLLM's is the reference: checked against the costs Claude Code
 * computes itself, it gives the same rates to the cent, including one-hour cache writes.
 * models.dev fills the gaps, the OpenCode gateway's own models above all, but knows a single
 * cache-write rate.
 */

/** Dollars per million tokens. A null rate falls back on the next cheaper assumption in `costOf`. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
  cacheWrite1h: number | null
}

export type PriceTable = Record<string, ModelPrice>

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
}

/**
 * Vendors selling their own models. Resellers and clouds list the same models at other prices
 * under the same names: keeping them would let a lookup land on a markup.
 */
const LITELLM_VENDORS = new Set(['anthropic', 'openai', 'xai', 'gemini', 'mistral', 'deepseek', 'zai', 'moonshot'])
const MODELS_DEV_VENDORS = ['anthropic', 'openai', 'google', 'xai', 'mistral', 'deepseek', 'zai', 'moonshotai', 'opencode']
/** Prefixes tried for a bare model name, in the vocabulary of both lists. */
const LOOKUP_VENDORS = ['anthropic', 'openai', 'xai', 'gemini', 'google', 'mistral', 'deepseek', 'zai', 'moonshot', 'moonshotai']

const rate = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)
/** Per-token rates accumulate binary noise once scaled: 4e-6 must read as 4, not 3.9999999999999996. */
const perMillion = (value: number | null): number | null => (value === null ? null : Number((value * 1e6).toPrecision(12)))

export function reduceLitellm(json: unknown): PriceTable {
  const table: PriceTable = {}
  for (const [key, value] of Object.entries(record(json) ?? {})) {
    const entry = record(value)
    if (!entry || typeof entry.litellm_provider !== 'string' || !LITELLM_VENDORS.has(entry.litellm_provider)) continue
    if (entry.mode !== 'chat' && entry.mode !== 'responses') continue
    const input = perMillion(rate(entry.input_cost_per_token))
    const output = perMillion(rate(entry.output_cost_per_token))
    if (input === null || output === null) continue
    table[key.toLowerCase()] = {
      input,
      output,
      cacheRead: perMillion(rate(entry.cache_read_input_token_cost)),
      cacheWrite: perMillion(rate(entry.cache_creation_input_token_cost)),
      cacheWrite1h: perMillion(rate(entry.cache_creation_input_token_cost_above_1hr)),
    }
  }
  return table
}

export function reduceModelsDev(json: unknown): PriceTable {
  const table: PriceTable = {}
  const providers = record(json) ?? {}
  for (const vendor of MODELS_DEV_VENDORS) {
    for (const [id, value] of Object.entries(record(record(providers[vendor])?.models) ?? {})) {
      const cost = record(record(value)?.cost)
      const input = rate(cost?.input)
      const output = rate(cost?.output)
      if (!cost || input === null || output === null) continue
      table[`${vendor}/${id}`.toLowerCase()] = { input, output, cacheRead: rate(cost.cache_read), cacheWrite: rate(cost.cache_write), cacheWrite1h: null }
    }
  }
  return table
}

/**
 * Keys a CLI's model identifier may be listed under, most exact first. CLIs decorate names
 * (`claude-opus-5[1m]`, `opencode/glm-5.2`, a dated snapshot) and the lists prefix some vendors
 * (`xai/grok-4.7`).
 */
export function priceKeys(model: string): string[] {
  const id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  if (!id) return []
  const bare = id.slice(id.indexOf('/') + 1)
  const names = [id, bare, ...LOOKUP_VENDORS.map((vendor) => `${vendor}/${bare}`)]
  return [...new Set([...names, ...names.map((name) => name.replace(/-\d{8}$/, ''))])]
}

/** First table wins for a given key, and an exact key wins over a looser one in any table. */
export function findPrice(tables: PriceTable[], model: string): ModelPrice | null {
  for (const key of priceKeys(model)) {
    for (const table of tables) {
      const price = table[key]
      if (price) return price
    }
  }
  return null
}

/**
 * List price of a consumption, in dollars. Standard rates only: long-context tiers, priority or
 * batch processing and per-request tools are not known per turn.
 */
export function costOf(price: ModelPrice, tokens: TokenCounts): number {
  const cacheWrite = price.cacheWrite ?? price.input
  return (
    tokens.inputTokens * price.input
    + tokens.outputTokens * price.output
    + tokens.cacheReadTokens * (price.cacheRead ?? price.input)
    + tokens.cacheWriteTokens * cacheWrite
    + tokens.cacheWrite1hTokens * (price.cacheWrite1h ?? cacheWrite)
  ) / 1e6
}
