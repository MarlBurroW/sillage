import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { benchmarkPresets, type BenchmarkPresetRow, type Db } from '@sillage/db'
import {
  DEFAULT_BENCHMARK_DURATION_MINUTES,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  MAX_BENCHMARK_CONCURRENCY,
  MAX_BENCHMARK_DURATION_MINUTES,
  MAX_BENCHMARK_PRESETS,
  MAX_BENCHMARK_REPETITIONS,
  MAX_CHECK_TIMEOUT_SECONDS,
  MIN_BENCHMARK_DURATION_MINUTES,
  MIN_CHECK_TIMEOUT_SECONDS,
  agentConfigSchema,
  agentKindSchema,
  benchmarkComparisonDraftSchema,
  shortModelName,
  validComparisonDraft,
  type AgentConfig,
  type BenchmarkComparisonDraft,
  type BenchmarkPresetData,
  type BenchmarkPresetDto,
  type BenchmarkPresetVariantDto,
} from '@sillage/protocol'
import { conflict, notFound } from '../http/errors.js'
import type { PriceCatalog } from '../pricing/catalog.js'

/**
 * Saved starting points of the creation form, personal like benchmarks.
 *
 * Writes are strict, reads lenient: a configuration saved months ago may name an option a CLI has
 * since dropped, and that variant must come back flagged rather than fail the whole list or be
 * silently rewritten. Rows are never rewritten on read.
 */

const STORED_VERSION = 1

const nameKey = (name: string) => name.trim().toLowerCase()

/** Folders granted to one conversation say nothing about the next benchmark, as for account defaults. */
function storedConfig(config: AgentConfig): AgentConfig {
  return { ...config, additionalDirectories: [] } as AgentConfig
}

function storedData(body: BenchmarkPresetData): string {
  const { name: _name, variants, ...rest } = body
  return JSON.stringify({
    version: STORED_VERSION,
    ...rest,
    variants: variants.map((variant) => ({ config: storedConfig(variant.config), label: variant.label ?? null })),
  })
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** A stored number within today's bounds: limits may have moved since the preset was saved. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/** What the reference lists say about a configured model; aliases name no model and get nothing. */
function modelFacts(model: string, prices: PriceCatalog | null): Pick<BenchmarkPresetVariantDto, 'model' | 'publicName' | 'listPrice'> {
  const listPrice = model && prices ? prices.priceOf(model) : null
  const name = model && prices ? prices.nameOf(model) : null
  return listPrice || name ? { model, publicName: name ? shortModelName(name) : null, listPrice } : { model: null, publicName: null, listPrice: null }
}

function readVariant(value: unknown, prices: PriceCatalog | null): BenchmarkPresetVariantDto {
  const entry = record(value)
  const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : null
  const parsed = agentConfigSchema.safeParse(entry.config)
  if (parsed.success) return { config: parsed.data, agent: parsed.data.agent, label, problem: null, ...modelFacts(parsed.data.model, prices) }
  const agent = agentKindSchema.safeParse(record(entry.config).agent)
  return { config: null, agent: agent.success ? agent.data : null, label, problem: 'invalid_config', model: null, publicName: null, listPrice: null }
}

export function presetToDto(row: BenchmarkPresetRow, prices: PriceCatalog | null = null): BenchmarkPresetDto {
  let data: Record<string, unknown> = {}
  try {
    data = record(JSON.parse(row.data))
  } catch {
    // An unreadable row still lists, empty, so it can be deleted.
  }
  const variants = (Array.isArray(data.variants) ? data.variants : []).map((value) => readVariant(value, prices))
  const comparisons: BenchmarkComparisonDraft[] = (Array.isArray(data.comparisons) ? data.comparisons : []).flatMap((value) => {
    const parsed = benchmarkComparisonDraftSchema.safeParse(value)
    return parsed.success && validComparisonDraft(parsed.data, variants.length) ? [parsed.data] : []
  })
  return {
    id: row.id,
    name: row.name,
    variants,
    repetitions: clamp(data.repetitions, 1, MAX_BENCHMARK_REPETITIONS, 1),
    concurrency: clamp(data.concurrency, 1, MAX_BENCHMARK_CONCURRENCY, 1),
    maxDurationMinutes: clamp(data.maxDurationMinutes, MIN_BENCHMARK_DURATION_MINUTES, MAX_BENCHMARK_DURATION_MINUTES, DEFAULT_BENCHMARK_DURATION_MINUTES),
    comparisons,
    prompt: typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt : null,
    checkScript: typeof data.checkScript === 'string' && data.checkScript.trim() ? data.checkScript : null,
    checkTimeoutSeconds: clamp(data.checkTimeoutSeconds, MIN_CHECK_TIMEOUT_SECONDS, MAX_CHECK_TIMEOUT_SECONDS, DEFAULT_CHECK_TIMEOUT_SECONDS),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  }
}

export class BenchmarkPresets {
  /** Without prices (tests that do not look at them), presets carry no model facts. */
  constructor(private readonly db: Db, private readonly prices: PriceCatalog | null = null) {}

  /** Recently used first, then by name: the menu offers what was just worked with. */
  list(userId: string): BenchmarkPresetDto[] {
    return this.db
      .select()
      .from(benchmarkPresets)
      .where(eq(benchmarkPresets.userId, userId))
      .orderBy(desc(sql`coalesce(${benchmarkPresets.lastUsedAt}, 0)`), asc(benchmarkPresets.nameKey))
      .all()
      .map((row) => presetToDto(row, this.prices))
  }

  create(userId: string, body: BenchmarkPresetData): BenchmarkPresetDto {
    const count = this.db.select({ count: sql<number>`count(*)` }).from(benchmarkPresets).where(eq(benchmarkPresets.userId, userId)).get()?.count ?? 0
    if (count >= MAX_BENCHMARK_PRESETS) {
      throw conflict('benchmark_preset_limit', 'An account keeps {max} presets at most: delete one first.', { max: MAX_BENCHMARK_PRESETS })
    }
    this.assertNameFree(userId, body.name, null)
    const now = Date.now()
    const row: BenchmarkPresetRow = {
      id: randomUUID(), userId, name: body.name, nameKey: nameKey(body.name), data: storedData(body),
      createdAt: now, updatedAt: now, lastUsedAt: null,
    }
    this.db.insert(benchmarkPresets).values(row).run()
    return presetToDto(row, this.prices)
  }

  /** Whole replacement: renaming sends the preset back with its new name. */
  replace(userId: string, id: string, body: BenchmarkPresetData): BenchmarkPresetDto {
    this.load(userId, id)
    this.assertNameFree(userId, body.name, id)
    this.db
      .update(benchmarkPresets)
      .set({ name: body.name, nameKey: nameKey(body.name), data: storedData(body), updatedAt: Date.now() })
      .where(and(eq(benchmarkPresets.id, id), eq(benchmarkPresets.userId, userId)))
      .run()
    return presetToDto(this.load(userId, id), this.prices)
  }

  remove(userId: string, id: string): void {
    this.load(userId, id)
    this.db.delete(benchmarkPresets).where(and(eq(benchmarkPresets.id, id), eq(benchmarkPresets.userId, userId))).run()
  }

  /** Another account's preset answers like a missing one: its existence is not theirs to learn. */
  private load(userId: string, id: string): BenchmarkPresetRow {
    const row = this.db.select().from(benchmarkPresets).where(and(eq(benchmarkPresets.id, id), eq(benchmarkPresets.userId, userId))).get()
    if (!row) throw notFound('benchmark_preset_not_found', 'Preset not found.')
    return row
  }

  private assertNameFree(userId: string, name: string, except: string | null): void {
    const taken = this.db
      .select({ id: benchmarkPresets.id })
      .from(benchmarkPresets)
      .where(and(eq(benchmarkPresets.userId, userId), eq(benchmarkPresets.nameKey, nameKey(name)), except ? ne(benchmarkPresets.id, except) : undefined))
      .get()
    if (taken) throw conflict('benchmark_preset_exists', 'A preset named “{name}” already exists.', { name: name.trim() })
  }
}
