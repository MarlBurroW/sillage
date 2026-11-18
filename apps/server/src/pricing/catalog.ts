import { eq } from 'drizzle-orm'
import { priceCatalogs, type Db } from '@sillage/db'
import type { PriceCatalogStatus } from '@sillage/protocol'
import bundled from './bundled.json' with { type: 'json' }
import { findName, findPrice, hasNames, ratesOf, reduceLitellm, reduceModelsDev, type ModelPrice, type PriceTable } from './prices.js'

const HOUR = 60 * 60 * 1000
/** Prices change a few times a year: a daily check is already generous. */
const CHECK_EVERY = 24 * HOUR

/** In lookup order: the first source listing a model sets its price. */
export const PRICE_SOURCES = [
  {
    id: 'litellm',
    url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    reduce: reduceLitellm,
    // A list this short is a truncated or reshaped file, not a price list: keep the previous one.
    minimum: 100,
  },
  { id: 'modelsdev', url: 'https://models.dev/api.json', reduce: reduceModelsDev, minimum: 100 },
] as const

type SourceId = typeof PRICE_SOURCES[number]['id']
type Download = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Pick<Response, 'status' | 'ok' | 'headers' | 'json'>>

interface Loaded { table: PriceTable; fetchedAt: number; checkedAt: number | null; etag: string | null }

/**
 * The price lists in use: the last ones fetched, or those shipped with the build until the
 * instance has reached the network once. A failed check never empties anything.
 */
export class PriceCatalog {
  private readonly loaded = new Map<SourceId, Loaded>()
  private error: PriceCatalogStatus['error'] = null
  private inflight: Promise<void> | null = null
  /** Names of the shipped list: a stored table reduced before names were kept has none. */
  private readonly shippedNames: PriceTable
  private namesRequested = false

  constructor(private readonly db: Db, private readonly download: Download = fetch, private readonly now = Date.now) {
    const shipped = bundled as unknown as { fetchedAt: number } & Record<SourceId, PriceTable>
    this.shippedNames = shipped.modelsdev ?? {}
    for (const source of PRICE_SOURCES) {
      const row = db.select().from(priceCatalogs).where(eq(priceCatalogs.source, source.id)).get()
      let table: PriceTable | null = null
      try { table = row ? JSON.parse(row.data) as PriceTable : null } catch { /* An unreadable row falls back on the shipped list. */ }
      this.loaded.set(source.id, row && table
        ? { table, fetchedAt: row.fetchedAt, checkedAt: row.checkedAt, etag: row.etag }
        : { table: shipped[source.id] ?? {}, fetchedAt: shipped.fetchedAt, checkedAt: null, etag: null })
    }
  }

  priceOf(model: string): ModelPrice | null {
    const price = findPrice(this.tables(), model)
    return price ? ratesOf(price) : null
  }

  /** Public name of a model ("GPT-6.2 Astra"), or null when no list names it. */
  nameOf(model: string): string | null {
    return findName([...this.tables(), this.shippedNames], model)
  }

  private tables(): PriceTable[] {
    return PRICE_SOURCES.map((source) => this.loaded.get(source.id)!.table)
  }

  /** Describes the reference list: the fallback only fills gaps and its age says little. */
  status(): PriceCatalogStatus {
    const reference = this.loaded.get(PRICE_SOURCES[0].id)!
    return { updatedAt: reference.fetchedAt, checkedAt: reference.checkedAt, origin: reference.checkedAt === null ? 'bundled' : 'online', error: this.error }
  }

  start(): void {
    const check = () => {
      const reference = this.loaded.get(PRICE_SOURCES[0].id)!
      // A models.dev list stored before names were kept would leave benchmarks unnamed for a day.
      const unnamed = !this.namesRequested && !hasNames(this.loaded.get('modelsdev')!.table)
      if (reference.checkedAt === null || this.now() - reference.checkedAt >= CHECK_EVERY || unnamed) {
        this.namesRequested = true
        void this.refresh()
      }
    }
    check()
    setInterval(check, HOUR).unref()
  }

  /** Asks every source now. Never rejects: the outcome is in `status()`. */
  refresh(): Promise<void> {
    this.inflight ??= this.refreshAll().finally(() => { this.inflight = null })
    return this.inflight
  }

  private async refreshAll(): Promise<void> {
    let error: PriceCatalogStatus['error'] = null
    // One at a time: each list is several megabytes of JSON while it is being reduced.
    for (const source of PRICE_SOURCES) {
      const current = this.loaded.get(source.id)!
      // An unchanged list answers 304 and would never be reduced again with its names.
      const unnamed = source.id === 'modelsdev' && !hasNames(current.table)
      try {
        const response = await this.download(source.url, {
          headers: { 'user-agent': 'sillage-prices', ...(current.etag && !unnamed ? { 'if-none-match': current.etag } : {}) },
          signal: AbortSignal.timeout(30_000),
        })
        const checkedAt = this.now()
        if (response.status === 304) {
          this.db.update(priceCatalogs).set({ checkedAt }).where(eq(priceCatalogs.source, source.id)).run()
          this.loaded.set(source.id, { ...current, checkedAt })
          continue
        }
        if (!response.ok) { error ??= 'network'; continue }
        const table = source.reduce(await response.json())
        if (Object.keys(table).length < source.minimum) { error ??= 'invalid'; continue }
        const data = JSON.stringify(table)
        const etag = response.headers.get('etag')
        // An identical list keeps its date: "updated" means the prices may have moved.
        const fetchedAt = current.checkedAt !== null && JSON.stringify(current.table) === data ? current.fetchedAt : checkedAt
        const values = { source: source.id, data, etag, fetchedAt, checkedAt }
        this.db.insert(priceCatalogs).values(values).onConflictDoUpdate({ target: priceCatalogs.source, set: values }).run()
        this.loaded.set(source.id, { table, fetchedAt, checkedAt, etag })
      } catch {
        error ??= 'network'
      }
    }
    this.error = error
  }
}
