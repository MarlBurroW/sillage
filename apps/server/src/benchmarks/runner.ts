import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, asc, desc, eq, inArray, lte, or } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { PriceCatalog } from '../pricing/catalog.js'
import { runCostUsd } from './cost.js'
import {
  benchmarkPresets,
  benchmarkRuns,
  benchmarks,
  conversations,
  events,
  personalWorkspaces,
  writeTransaction,
  type BenchmarkRow,
  type BenchmarkRunRow,
  type Db,
} from '@sillage/db'
import {
  BENCHMARK_FOLLOW_UP_STATUSES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_BENCHMARK_TOTAL_VARIANTS,
  MAX_BENCHMARK_VARIANTS,
  agentConfigSchema,
  benchmarkComparisonsSchema,
  benchmarkInputsSchema,
  benchmarkSeriesRoot,
  benchmarkVariantsSchema,
  isCustomVariantLabel,
  lineupEffortsDiffer,
  nextVariantIndex,
  shortModelName,
  startedRepetitions,
  defaultVariantLabel,
  validComparisonDraft,
  variantDisplayLabel,
  variantEffort,
  type AgentConfig,
  type BenchmarkCheckResult,
  type BenchmarkComparison,
  type BenchmarkDeliverable,
  type BenchmarkDto,
  type BenchmarkFollowUp,
  type BenchmarkInput,
  type BenchmarkRunDto,
  type BenchmarkRunMetrics,
  type BenchmarkVariant,
  type BenchmarkVariantDto,
  type CreateBenchmarkData,
  type UpdateBenchmarkLineupData,
  type UpdateBenchmarkSettingsBody,
} from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import type { OutgoingAttachment } from '../agents/types.js'
import { isInlineImage, type AttachmentStore } from '../attachments/store.js'
import { createConversation } from '../conversations/create.js'
import { deleteConversation } from '../conversations/delete.js'
import { createPersonalWorkspace } from '../conversations/personal-workspaces.js'
import { EventLog } from '../events/event-log.js'
import type { AppContext } from '../http/context.js'
import { HttpError, badRequest, notFound } from '../http/errors.js'
import { runScript } from '../scheduler/check.js'
import type { SessionManager } from '../sessions/session-manager.js'
import { listDeliverables } from './deliverables.js'
import { readRunMetrics, readWaitingMs, RUN_METRICS_VERSION, upgradeSnapshot } from './metrics.js'
import { detach } from '../detach.js'

/**
 * Executes benchmarks: opens one fresh personal session per run, waits for it to settle, runs the
 * benchmark's script in its folder, folds its journal into measurements. Sweeps database state
 * like `TaskScheduler` rather than holding runs in memory: a restart interrupts sessions but
 * leaves pending runs to launch afterwards, and every sweep decides from rows what to start next.
 */

const TICK_MS = 5000

/** How long a live rendering's production links work: long enough for a recording session. */
const LIVE_TOKEN_MS = 12 * 60 * 60 * 1000

/** Answers longer than this are rare and stay whole in the run's conversation. */
const MAX_RESPONSE_CHARS = 20000

export function readVariants(raw: string): BenchmarkVariant[] {
  return benchmarkVariantsSchema.parse(JSON.parse(raw))
}

function readInputs(raw: string): BenchmarkInput[] {
  return benchmarkInputsSchema.parse(JSON.parse(raw))
}

/**
 * Variants exactly as stored, for writes. Frozen configurations go back byte for byte: a Zod
 * parse would add today's defaults to what actually ran.
 */
interface StoredVariant {
  id: string
  label: string
  config: unknown
  addedAt?: number
}

function storedVariants(raw: string): StoredVariant[] {
  return JSON.parse(raw) as StoredVariant[]
}

/** The label a variant shows when nobody wrote one; the stored label when its config no longer parses. */
function automaticLabel(variant: StoredVariant): string {
  const config = agentConfigSchema.safeParse(variant.config)
  return config.success ? defaultVariantLabel(config.data) : variant.label
}

/** Comparisons naming variants the benchmark still has; one left with a single contestant is dropped. */
function readComparisons(raw: string | null, ids: Set<string>): BenchmarkComparison[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const result = benchmarkComparisonsSchema.safeParse(parsed)
  if (!result.success) return []
  return result.data.flatMap((comparison) => {
    const variantIds = [...new Set(comparison.variantIds)].filter((id) => ids.has(id))
    return variantIds.length >= 2 ? [{ ...comparison, variantIds }] : []
  })
}

/** Same rule as `startedRepetitions`: a run that left a session, measurements or a verdict. */
function runStarted(run: Pick<BenchmarkRunRow, 'conversationId' | 'status'>): boolean {
  return run.conversationId !== null || (run.status !== 'pending' && run.status !== 'cancelled')
}

/** Starting files live beside the database, never in a run folder an agent may rewrite. */
export function benchmarkInputDir(dataDir: string, benchmarkId: string): string {
  return join(dataDir, 'benchmarks', benchmarkId, 'inputs')
}

function readFollowUps(raw: string | null): BenchmarkFollowUp[] {
  return raw ? (JSON.parse(raw) as BenchmarkFollowUp[]) : []
}

export function runToDto(row: BenchmarkRunRow): BenchmarkRunDto {
  return {
    id: row.id,
    variantId: row.variantId,
    repetition: row.repetition,
    conversationId: row.conversationId,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
    cliVersion: row.cliVersion,
    metrics: row.metrics ? (JSON.parse(row.metrics) as BenchmarkRunMetrics) : null,
    response: row.response,
    check: row.check ? (JSON.parse(row.check) as BenchmarkCheckResult) : null,
    files: row.files ? (JSON.parse(row.files) as BenchmarkDeliverable[]) : [],
    previewToken: row.previewToken,
    rating: row.rating,
    ratingNote: row.ratingNote,
    followUps: readFollowUps(row.followUps),
  }
}

/** Model the CLI reported at session start, from the first of the variant's runs that has one. */
function announcedModel(db: Db, runs: BenchmarkRunRow[], benchmarkId: string, variantId: string): string | null {
  for (const run of runs) {
    if (run.benchmarkId !== benchmarkId || run.variantId !== variantId) continue
    const model = run.metrics ? (JSON.parse(run.metrics) as BenchmarkRunMetrics).model : null
    if (model) return model
    if (!run.conversationId) continue
    // Metrics are frozen at settlement, but the CLI announces its model during startup.
    // Read just that event so polling a running benchmark never folds its whole journal.
    const announcement = db.select({ payload: events.payload }).from(events).where(and(
      eq(events.conversationId, run.conversationId),
      eq(events.type, 'session.started'),
      run.finishedAt === null ? undefined : lte(events.ts, run.finishedAt),
    )).orderBy(asc(events.seq)).limit(1).get()
    if (announcement) {
      const announced = JSON.parse(announcement.payload) as { model?: string }
      if (announced.model) return announced.model
    }
  }
  return null
}


/** A run waiting for its slot: nothing measured, no session yet. */
function pendingRun(benchmarkId: string, variantId: string, repetition: number): BenchmarkRunRow {
  return {
    id: randomUUID(), benchmarkId, variantId, repetition,
    conversationId: null, status: 'pending', startedAt: null, finishedAt: null, error: null,
    cliVersion: null, metrics: null, response: null, check: null, files: null, previewToken: null,
    rating: null, ratingNote: null, ratedAt: null, followUps: null,
  }
}

/** With `prices`, each run's cost is recomputed at today's public prices (see `runCostUsd`); without, the stored one stands. */
export function benchmarksToDto(db: Db, rows: BenchmarkRow[], prices: PriceCatalog | null = null): BenchmarkDto[] {
  if (rows.length === 0) return []
  const runs = db
    .select()
    .from(benchmarkRuns)
    .where(inArray(benchmarkRuns.benchmarkId, rows.map((row) => row.id)))
    .orderBy(asc(benchmarkRuns.variantId), asc(benchmarkRuns.repetition))
    .all()
  // Repair persisted measurements once, so existing benchmarks and exports benefit too.
  // Bound the journal at settlement: later discussion turns are outside the benchmark.
  let log: EventLog | undefined
  for (const run of runs) {
    if (!run.metrics || run.finishedAt === null) continue
    const metrics = JSON.parse(run.metrics) as BenchmarkRunMetrics
    if ((metrics.version ?? 0) >= RUN_METRICS_VERSION) continue
    const benchmark = rows.find((row) => row.id === run.benchmarkId)!
    const agent = readVariants(benchmark.variants).find((variant) => variant.id === run.variantId)?.config.agent
    // A deleted thread keeps its id here (no foreign key): folding its missing journal would
    // replace the stored measures with nulls stamped current, beyond any later repair.
    const journal = run.conversationId
      ? db.select({ lastSeq: conversations.lastSeq }).from(conversations).where(eq(conversations.id, run.conversationId)).get()
      : undefined
    const updated = run.conversationId && journal && journal.lastSeq > 0
      ? readRunMetrics(log ??= new EventLog(db), run.conversationId, agent, run.finishedAt)
      : upgradeSnapshot(metrics)
    run.metrics = JSON.stringify(updated)
    db.update(benchmarkRuns).set({ metrics: run.metrics }).where(eq(benchmarkRuns.id, run.id)).run()
  }
  return rows.map((row) => {
    const variants = readVariants(row.variants)
    const position = new Map(variants.map((variant, index) => [variant.id, index]))
    const effortsDiffer = lineupEffortsDiffer(variants.map((variant) => variant.config))
    const at = (variantId: string) => position.get(variantId) ?? Number.MAX_SAFE_INTEGER
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      variants: variants.map((variant) => variantToDto(variant, announcedModel(db, runs, row.id, variant.id), effortsDiffer, prices)),
      comparisons: readComparisons(row.comparisons, new Set(position.keys())),
      repetitions: row.repetitions,
      concurrency: row.maxConcurrentRuns ?? (row.concurrency === 'parallel' ? 4 : 1),
      maxDurationMinutes: row.maxDurationMinutes,
      inputs: readInputs(row.inputs).map(({ filename, mimeType, sizeBytes }) => ({ filename, mimeType, sizeBytes })),
      checkScript: row.checkScript,
      checkTimeoutSeconds: row.checkTimeoutSeconds,
      seriesId: row.seriesId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // In lineup order, not by id: as strings, v10 sorts before v2.
      runs: runs
        .filter((run) => run.benchmarkId === row.id)
        .sort((a, b) => at(a.variantId) - at(b.variantId) || a.repetition - b.repetition)
        .map((run) => {
          const dto = runToDto(run)
          return prices && dto.metrics ? { ...dto, metrics: { ...dto.metrics, costUsd: runCostUsd(db, prices, run, dto.metrics) } } : dto
        }),
    }
  })
}

/**
 * A variant as pages read it. The technical label names the model that answered (or the
 * configured value until a run announces one); the shown label is the user's, otherwise the
 * public name of that model. A configured alias ('opus', 'default') is priced and named only once
 * a run announced the model behind it, since aliases move between generations.
 */
function variantToDto(variant: BenchmarkVariant, announced: string | null, effortsDiffer: boolean, prices: PriceCatalog | null): BenchmarkVariantDto {
  const technicalLabel = defaultVariantLabel(announced ? { ...variant.config, model: announced } : variant.config)
  const configured = variant.config.model
  const model = announced ?? (prices && configured && (prices.priceOf(configured) || prices.nameOf(configured)) ? configured : null)
  const publicName = model && prices ? prices.nameOf(model) : null
  return {
    ...variant,
    label: variantDisplayLabel(variant, technicalLabel, publicName, effortsDiffer),
    technicalLabel,
    labelIsCustom: isCustomVariantLabel(variant),
    model,
    listPrice: model && prices ? prices.priceOf(model) : null,
    publicName: publicName ? shortModelName(publicName) : null,
  }
}

type Outcome = { status: 'succeeded' | 'failed' | 'timed_out'; error: string | null }

export class BenchmarkRunner {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private again = false
  private logger: FastifyBaseLogger | null = null
  /** Runs whose CLI is starting: a sweep during those seconds must not launch them twice. */
  private readonly launching = new Set<string>()
  /** Runs whose follow-up is being sent: their rows reopen only once the message is announced. */
  private readonly followingUp = new Set<string>()
  /**
   * Short-lived stand-ins for run preview tokens, minted for the owner's live renderings. A link
   * hovered inside a production shows its address in the status bubble, which a recording or a
   * screen share captures; a token seen there must stop working, whereas a run's own token lasts
   * as long as its thread. Kept in memory: a restart only asks for a reload.
   */
  private readonly liveTokens = new Map<string, { previewToken: string; expiresAt: number }>()

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    private readonly registry: AgentRegistry,
    private readonly log: EventLog,
    private readonly attachments: AttachmentStore,
    /** Absent in tests that do not look at costs. */
    private readonly prices: PriceCatalog | null = null,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    // A script killed with the previous process never reported: settle those runs again, which
    // reruns the script against the folder the session left.
    this.ctx.db.update(benchmarkRuns).set({ status: 'running' }).where(eq(benchmarkRuns.status, 'checking')).run()
    this.timer = setInterval(() => detach(this.tick(), 'benchmark runner pass'), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Immediate sweep after a creation or cancellation, instead of waiting for the interval. */
  kick(): void {
    if (this.busy) {
      this.again = true
      return
    }
    detach(this.tick(), 'benchmark runner pass')
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      // Settle first: a finished sequential run frees its slot within the same sweep.
      await this.settle(now)
      await this.launchPending()
    } catch (err) {
      this.logger?.error({ err }, 'benchmark sweep failed')
    } finally {
      this.busy = false
    }
    if (this.again) {
      this.again = false
      setImmediate(() => detach(this.tick(), 'benchmark runner pass'))
    }
  }

  /**
   * Resolves CLI defaults before writing: frozen variants must name the model that actually ran.
   * Shared by creation and continuation, which accept the same variants.
   */
  private async resolveVariants(inputs: { config: AgentConfig; label?: string | null }[]): Promise<{ label: string; config: AgentConfig }[]> {
    const resolved: { label: string; config: AgentConfig }[] = []
    for (const input of inputs) {
      this.sessions.assertCliEnabled(input.config.agent)
      const config = await this.registry.adapter(input.config.agent).resolveDefaults(input.config)
      resolved.push({ label: input.label ?? defaultVariantLabel(config), config })
    }
    return resolved
  }

  async create(userId: string, body: CreateBenchmarkData): Promise<BenchmarkRow> {
    const variants: BenchmarkVariant[] = (await this.resolveVariants(body.variants)).map((variant, index) => ({ id: `v${index + 1}`, ...variant }))
    // "New from this benchmark" keeps the source's starting files; only the account's own.
    const source = body.inputsFrom ? this.load(body.inputsFrom, userId) : null
    const copied = source ? readInputs(source.inputs) : []
    if (copied.length + body.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw badRequest('benchmark_inputs_limit', 'A benchmark takes {max} starting files at most.', { max: MAX_ATTACHMENTS_PER_MESSAGE })
    }

    const id = randomUUID()
    const uploads = this.attachments.listClaimable(userId, body.attachmentIds)
    const missing = body.attachmentIds.find((attachmentId) => !uploads.some((row) => row.id === attachmentId))
    if (missing) throw badRequest('attachment_unavailable', 'Attachment {id} is unavailable or has already been sent.', { id: missing })
    // Copy uploads under the benchmark: each run will turn them into its own attachments, and the
    // originals are released below rather than claimed by a single conversation.
    const inputs: BenchmarkInput[] = [...copied]
    const inputDir = benchmarkInputDir(this.ctx.config.paths.data, id)
    try {
      if (source && copied.length > 0) await cp(benchmarkInputDir(this.ctx.config.paths.data, source.id), inputDir, { recursive: true })
      if (uploads.length > 0) await mkdir(inputDir, { recursive: true })
      for (const [index, attachmentId] of body.attachmentIds.entries()) {
        const upload = uploads.find((row) => row.id === attachmentId)!
        // Numbered after the copied files, whose stored names already use the first numbers.
        const storedAs = `${copied.length + index + 1}-${upload.filename.replace(/[\\/]/g, '_')}`
        await copyFile(upload.storagePath, join(inputDir, storedAs))
        inputs.push({ storedAs, filename: upload.filename, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes })
      }
    } catch (err) {
      await rm(join(this.ctx.config.paths.data, 'benchmarks', id), { recursive: true, force: true })
      throw err
    }

    // Comparisons arrive by position, before the variants had ids.
    const comparisons: BenchmarkComparison[] = body.comparisons
      .filter((draft) => validComparisonDraft(draft, variants.length))
      .map((draft) => ({ id: randomUUID(), title: draft.title, variantIds: draft.variants.map((index) => variants[index]!.id) }))

    const now = Date.now()
    const row: BenchmarkRow = {
      id,
      userId,
      name: body.name,
      prompt: body.prompt,
      variants: JSON.stringify(variants),
      repetitions: body.repetitions,
      concurrency: body.concurrency > 1 ? 'parallel' : 'sequential',
      maxConcurrentRuns: body.concurrency,
      maxDurationMinutes: body.maxDurationMinutes,
      inputs: JSON.stringify(inputs),
      checkScript: body.checkScript,
      checkTimeoutSeconds: body.checkTimeoutSeconds,
      seriesId: null,
      comparisons: comparisons.length > 0 ? JSON.stringify(comparisons) : null,
      createdAt: now,
      updatedAt: now,
    }
    await this.insert(row, variants, body.presetId)
    for (const upload of uploads) await this.attachments.remove(upload.id)
    this.kick()
    return row
  }

  /**
   * Repeats a benchmark as it was: same prompt, files, script and frozen configurations. Only
   * what changed outside Sillage differs, the CLI release or the model behind an alias, which is
   * exactly what a rerun is for. The copy joins the original's series for side-by-side reading.
   */
  async rerun(benchmarkId: string, userId: string): Promise<BenchmarkRow> {
    const source = this.load(benchmarkId, userId)
    const variants = readVariants(source.variants)
    for (const variant of variants) this.sessions.assertCliEnabled(variant.config.agent)
    const id = randomUUID()
    const inputs = readInputs(source.inputs)
    if (inputs.length > 0) {
      await cp(benchmarkInputDir(this.ctx.config.paths.data, source.id), benchmarkInputDir(this.ctx.config.paths.data, id), { recursive: true })
    }
    const now = Date.now()
    // A rerun measures the whole lineup at once: none of its variants was added later.
    const stored = storedVariants(source.variants)
    const lineup = stored.some((variant) => variant.addedAt !== undefined)
      ? JSON.stringify(stored.map(({ addedAt: _addedAt, ...variant }) => variant))
      : source.variants
    const row: BenchmarkRow = { ...source, id, variants: lineup, seriesId: benchmarkSeriesRoot(source), createdAt: now, updatedAt: now }
    await this.insert(row, variants)
    this.kick()
    return row
  }

  /**
   * Writes a benchmark with one pending run per variant and repetition; removes its files if that
   * fails. The preset it came from, the owner's only, moves up the presets menu.
   */
  private async insert(row: BenchmarkRow, variants: BenchmarkVariant[], presetId: string | null = null): Promise<void> {
    try {
      writeTransaction(this.ctx.db, (tx) => {
        tx.insert(benchmarks).values(row).run()
        for (const variant of variants) {
          for (let repetition = 1; repetition <= row.repetitions; repetition += 1) {
            tx.insert(benchmarkRuns).values(pendingRun(row.id, variant.id, repetition)).run()
          }
        }
        if (presetId) {
          tx.update(benchmarkPresets).set({ lastUsedAt: row.createdAt })
            .where(and(eq(benchmarkPresets.id, presetId), eq(benchmarkPresets.userId, row.userId))).run()
        }
      })
    } catch (err) {
      await rm(join(this.ctx.config.paths.data, 'benchmarks', row.id), { recursive: true, force: true })
      throw err
    }
  }

  /**
   * Adjusts how much a benchmark runs, at any point of its life. The slot limit and the duration
   * are read on every sweep, so they apply at once: a run already past a shortened duration is
   * interrupted on the next one. More repetitions queue new runs, which reopens a settled
   * benchmark; fewer only drop runs that never started, so no result is ever deleted.
   */
  updateSettings(benchmarkId: string, settings: UpdateBenchmarkSettingsBody): void {
    writeTransaction(this.ctx.db, (tx) => {
      const row = tx.select().from(benchmarks).where(eq(benchmarks.id, benchmarkId)).get()
      if (!row) throw notFound('benchmark_not_found', 'Benchmark not found.')
      const runs = tx.select().from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, benchmarkId)).all()
      // A run being launched is still pending in the database while its session starts.
      const started = startedRepetitions(runs.map((run) => (this.launching.has(run.id) ? { ...run, status: 'running' as const } : run)))
      if (settings.repetitions < started) {
        throw new HttpError(409, 'benchmark_repetitions_started', 'Runs per variant cannot go below {started}: those runs have already started.', { started })
      }
      const dropped = runs.filter((run) => run.repetition > settings.repetitions).map((run) => run.id)
      if (dropped.length > 0) tx.delete(benchmarkRuns).where(inArray(benchmarkRuns.id, dropped)).run()
      for (const variant of readVariants(row.variants)) {
        const known = new Set(runs.filter((run) => run.variantId === variant.id).map((run) => run.repetition))
        for (let repetition = 1; repetition <= settings.repetitions; repetition += 1) {
          if (!known.has(repetition)) tx.insert(benchmarkRuns).values(pendingRun(benchmarkId, variant.id, repetition)).run()
        }
      }
      tx.update(benchmarks).set({
        repetitions: settings.repetitions,
        maxConcurrentRuns: settings.concurrency,
        concurrency: settings.concurrency > 1 ? 'parallel' : 'sequential',
        maxDurationMinutes: settings.maxDurationMinutes,
        updatedAt: Date.now(),
      }).where(eq(benchmarks.id, benchmarkId)).run()
    })
    // Lowering the slot limit only delays pending runs; active runs keep their slots.
    this.kick()
  }

  /**
   * Saves the whole ordered lineup of an existing benchmark, which is how a benchmark is continued
   * when a new model comes out. The prompt, files and check script stay as they are, so a new
   * variant is measured on the same task; variants that already exist keep their frozen
   * configuration and only change place or label. New variants take ids no member of the series
   * uses yet (reruns copy ids, and History lines variants up by id) and queue their own runs.
   * Removing a variant deletes its runs and their conversations, so it needs confirmation once
   * one of them started, and is refused while one is running.
   */
  async updateLineup(benchmarkId: string, userId: string, body: UpdateBenchmarkLineupData): Promise<void> {
    this.load(benchmarkId, userId)
    const additions = body.variants.flatMap((entry) => ('config' in entry ? [entry] : []))
    if (additions.length > MAX_BENCHMARK_VARIANTS) {
      throw badRequest('benchmark_variants_per_launch', 'At most {max} variants can be added at once.', { max: MAX_BENCHMARK_VARIANTS })
    }
    // CLI probes are async and cannot run inside the write transaction.
    const resolved = await this.resolveVariants(additions)
    const removedThreads: string[] = []
    writeTransaction(this.ctx.db, (tx) => {
      const row = tx.select().from(benchmarks).where(eq(benchmarks.id, benchmarkId)).get()
      if (!row) throw notFound('benchmark_not_found', 'Benchmark not found.')
      const stored = storedVariants(row.variants)
      const byId = new Map(stored.map((variant) => [variant.id, variant]))
      // Omission means removal: a client that never saw a variant added meanwhile would delete it.
      if (body.base && (body.base.length !== stored.length || stored.some((variant) => !body.base!.includes(variant.id)))) {
        throw new HttpError(409, 'benchmark_lineup_changed', 'The lineup changed in the meantime: reload the benchmark and try again.')
      }
      const kept = new Set<string>()
      for (const entry of body.variants) {
        if ('config' in entry) continue
        // An id this benchmark does not have comes from a tab that missed another change.
        if (!byId.has(entry.id)) throw new HttpError(409, 'benchmark_lineup_changed', 'The lineup changed in the meantime: reload the benchmark and try again.')
        if (kept.has(entry.id)) throw badRequest('benchmark_lineup_duplicate', 'A variant appears twice in the lineup.')
        kept.add(entry.id)
      }
      if (kept.size + resolved.length > MAX_BENCHMARK_TOTAL_VARIANTS) {
        throw badRequest('benchmark_variants_limit', 'A benchmark holds {max} variants at most.', { max: MAX_BENCHMARK_TOTAL_VARIANTS })
      }

      const runs = tx.select().from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, benchmarkId)).all()
      const removed = stored.filter((variant) => !kept.has(variant.id))
      for (const variant of removed) {
        const own = runs.filter((run) => run.variantId === variant.id)
        // A run whose CLI is starting is still pending in the database.
        if (own.some((run) => run.status === 'running' || run.status === 'checking' || this.launching.has(run.id))) {
          throw new HttpError(409, 'benchmark_variant_running', '“{label}” is running: cancel the benchmark or wait for its runs before removing it.', { label: variant.label })
        }
        if (!body.confirmRemoval && own.some(runStarted)) {
          throw new HttpError(409, 'benchmark_variant_removal_unconfirmed', 'Removing “{label}” deletes its runs, their measurements and conversations.', { label: variant.label })
        }
      }

      const root = benchmarkSeriesRoot(row)
      const series = tx.select({ variants: benchmarks.variants }).from(benchmarks).where(or(eq(benchmarks.id, root), eq(benchmarks.seriesId, root))).all()
      let next = nextVariantIndex([row, ...series].flatMap((member) => storedVariants(member.variants).map((variant) => variant.id)))
      const now = Date.now()
      const fresh: string[] = []
      let added = 0
      const lineup = body.variants.map((entry): StoredVariant => {
        if ('config' in entry) {
          const variant = resolved[added++]!
          const id = `v${next++}`
          fresh.push(id)
          return { id, label: variant.label, config: variant.config, addedAt: now }
        }
        const existing = byId.get(entry.id)!
        return { ...existing, label: entry.label ?? automaticLabel(existing) }
      })

      for (const variant of removed) {
        const own = runs.filter((run) => run.variantId === variant.id)
        removedThreads.push(...own.flatMap((run) => (run.conversationId ? [run.conversationId] : [])))
        if (own.length > 0) tx.delete(benchmarkRuns).where(inArray(benchmarkRuns.id, own.map((run) => run.id))).run()
      }
      for (const id of fresh) {
        for (let repetition = 1; repetition <= row.repetitions; repetition += 1) {
          tx.insert(benchmarkRuns).values(pendingRun(benchmarkId, id, repetition)).run()
        }
      }
      const comparisons = readComparisons(row.comparisons, new Set(lineup.map((variant) => variant.id)))
      tx.update(benchmarks).set({
        variants: JSON.stringify(lineup),
        comparisons: comparisons.length > 0 ? JSON.stringify(comparisons) : null,
        updatedAt: now,
      }).where(eq(benchmarks.id, benchmarkId)).run()
    })
    // Runs were opened to be measured, not continued: their threads go with them, as on deletion.
    for (const thread of removedThreads) {
      await deleteConversation(this.ctx.db, this.sessions, this.attachments, thread).catch((err: unknown) => {
        this.logger?.warn({ err, conversation: thread }, 'removed benchmark variant left its conversation')
      })
    }
    this.kick()
  }

  /**
   * Replaces the comparisons kept with a benchmark. They name variants by id, so a comparison
   * survives reordering and renaming, and is pruned when a variant is removed.
   */
  updateComparisons(benchmarkId: string, comparisons: BenchmarkComparison[]): void {
    writeTransaction(this.ctx.db, (tx) => {
      const row = tx.select().from(benchmarks).where(eq(benchmarks.id, benchmarkId)).get()
      if (!row) throw notFound('benchmark_not_found', 'Benchmark not found.')
      const ids = new Set(storedVariants(row.variants).map((variant) => variant.id))
      const seen = new Set<string>()
      for (const comparison of comparisons) {
        if (seen.has(comparison.id)) throw badRequest('benchmark_comparison_duplicate', 'Two comparisons share one id.')
        seen.add(comparison.id)
        if (new Set(comparison.variantIds).size !== comparison.variantIds.length) {
          throw badRequest('benchmark_comparison_repeated', 'A comparison names the same variant twice.')
        }
        if (comparison.variantIds.some((id) => !ids.has(id))) {
          throw new HttpError(409, 'benchmark_comparison_unknown', 'A comparison names a variant this benchmark no longer has: reload it and try again.')
        }
      }
      tx.update(benchmarks).set({ comparisons: comparisons.length > 0 ? JSON.stringify(comparisons) : null, updatedAt: Date.now() })
        .where(eq(benchmarks.id, benchmarkId)).run()
    })
  }

  /** Records a human rating and comment. Allowed before settlement too: a page can be judged while the check runs. */
  rate(benchmarkId: string, runId: string, rating: number | null, note: string | null): void {
    const result = this.ctx.db
      .update(benchmarkRuns)
      .set({ rating, ratingNote: note, ratedAt: rating === null && note === null ? null : Date.now() })
      .where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.benchmarkId, benchmarkId)))
      .run()
    if (result.changes === 0) throw notFound('benchmark_run_not_found', 'Benchmark run not found.')
    this.touch(benchmarkId, Date.now())
  }

  /**
   * Continues settled runs with a human correction, each in its own session. The run reopens
   * instead of a new one starting: its next settlement folds the whole journal again, so the
   * correction's work adds to the first attempt's, and the check reruns on the folder the agent
   * left. The stars go, since they judged a result the correction is meant to change; the comment
   * stays, as the author's own words about the run.
   */
  async followUp(benchmarkId: string, runIds: string[], text: string): Promise<void> {
    const ids = [...new Set(runIds)]
    // A second request (another tab, a double click) would pass the same checks before the first
    // reopened the rows, send the message twice and keep only one of the two in the list.
    if (ids.some((id) => this.followingUp.has(id))) {
      throw new HttpError(409, 'benchmark_run_unsettled', 'Only a finished run can be followed up: wait for it to finish.')
    }
    const runs = this.ctx.db.select().from(benchmarkRuns)
      .where(and(eq(benchmarkRuns.benchmarkId, benchmarkId), inArray(benchmarkRuns.id, ids))).all()
    // Every run is checked before any message leaves: a refusal must not leave half of them sent.
    for (const id of ids) {
      const run = runs.find((entry) => entry.id === id)
      if (!run) throw notFound('benchmark_run_not_found', 'Benchmark run not found.')
      const thread = run.conversationId
        ? this.ctx.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, run.conversationId)).get()
        : undefined
      if (!thread) throw new HttpError(409, 'benchmark_run_thread_missing', 'This run no longer has its conversation: it cannot be continued.')
      if (!BENCHMARK_FOLLOW_UP_STATUSES.includes(run.status)) {
        throw new HttpError(409, 'benchmark_run_unsettled', 'Only a finished run can be followed up: wait for it to finish.')
      }
    }
    const variants = readVariants(this.ctx.db.select({ variants: benchmarks.variants }).from(benchmarks).where(eq(benchmarks.id, benchmarkId)).get()!.variants)
    for (const run of runs) {
      const agent = variants.find((variant) => variant.id === run.variantId)?.config.agent
      if (agent) this.sessions.assertCliEnabled(agent)
    }
    for (const id of ids) this.followingUp.add(id)
    try {
      for (const run of runs) {
        const sentAt = Date.now()
        // Sent before the row reopens: announcing the message marks the thread busy at once, so no
        // sweep can take the previous turn's verdict for this one.
        await this.sessions.sendMessage(run.conversationId!, randomUUID(), text)
        this.ctx.db.update(benchmarkRuns).set({
          status: 'running', finishedAt: null, error: null, metrics: null, response: null, check: null, files: null,
          rating: null,
          followUps: JSON.stringify([...readFollowUps(run.followUps), { text, sentAt }]),
        }).where(eq(benchmarkRuns.id, run.id)).run()
      }
    } finally {
      for (const id of ids) this.followingUp.delete(id)
      this.touch(benchmarkId, Date.now())
    }
  }

  /** Pending runs never start; running ones are terminated and still measured, since a partial run says something. */
  async cancel(benchmarkId: string): Promise<void> {
    const now = Date.now()
    this.ctx.db
      .update(benchmarkRuns)
      .set({ status: 'cancelled', finishedAt: now, error: 'Cancelled before launch.' })
      .where(and(eq(benchmarkRuns.benchmarkId, benchmarkId), eq(benchmarkRuns.status, 'pending')))
      .run()
    const running = this.ctx.db
      .select()
      .from(benchmarkRuns)
      .where(and(eq(benchmarkRuns.benchmarkId, benchmarkId), eq(benchmarkRuns.status, 'running')))
      .all()
    for (const run of running) {
      if (run.conversationId) await this.sessions.terminate(run.conversationId)
      await this.close(run, { status: 'failed', error: null }, now, 'cancelled', 'Cancelled by the user.')
    }
    this.touch(benchmarkId, now)
  }

  /** Runs' conversations go with the benchmark: they were opened to be measured, not to be continued. Their folders stay, like any discussion's. */
  async delete(benchmarkId: string): Promise<void> {
    await this.cancel(benchmarkId)
    // The row goes first, runs with it: a run whose CLI is still starting then finds no row and
    // removes the thread it opened (recordStart), instead of leaving one nothing lists.
    this.ctx.db.delete(benchmarks).where(eq(benchmarks.id, benchmarkId)).run()
    const threads = this.ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.benchmarkId, benchmarkId))
      .all()
    for (const thread of threads) await deleteConversation(this.ctx.db, this.sessions, this.attachments, thread.id)
    await rm(join(this.ctx.config.paths.data, 'benchmarks', benchmarkId), { recursive: true, force: true })
  }

  /** Folder of a launched run, for the preview route. Null for unknown tokens or deleted threads. */
  previewRoot(token: string): string | null {
    const live = this.liveTokens.get(token)
    if (live) {
      if (live.expiresAt > Date.now()) return this.previewRoot(live.previewToken)
      this.liveTokens.delete(token)
    }
    const row = this.ctx.db
      .select({ path: personalWorkspaces.path })
      .from(benchmarkRuns)
      .innerJoin(conversations, eq(conversations.id, benchmarkRuns.conversationId))
      .innerJoin(personalWorkspaces, eq(personalWorkspaces.id, conversations.workspaceId))
      .where(eq(benchmarkRuns.previewToken, token))
      .get()
    return row?.path ?? null
  }

  /** A stand-in for a run's preview token, valid for one sitting: see `liveTokens`. */
  liveToken(previewToken: string, now = Date.now()): string {
    for (const [token, entry] of this.liveTokens) if (entry.expiresAt <= now) this.liveTokens.delete(token)
    const token = randomBytes(24).toString('base64url')
    this.liveTokens.set(token, { previewToken, expiresAt: now + LIVE_TOKEN_MS })
    return token
  }

  // --- Launching -----------------------------------------------------------------

  private async launchPending(): Promise<void> {
    const pending = this.ctx.db
      .select({ run: benchmarkRuns, benchmark: benchmarks })
      .from(benchmarkRuns)
      .innerJoin(benchmarks, eq(benchmarks.id, benchmarkRuns.benchmarkId))
      .where(eq(benchmarkRuns.status, 'pending'))
      .orderBy(asc(benchmarks.createdAt), asc(benchmarkRuns.variantId), asc(benchmarkRuns.repetition))
      .all()
    if (pending.length === 0) return

    // A run under check still occupies its slot: the script competes for the machine like the
    // session did, and the next sequential run's duration must not pay for it.
    const active = new Map<string, number>()
    for (const row of this.ctx.db
      .select({ benchmarkId: benchmarkRuns.benchmarkId })
      .from(benchmarkRuns)
      .where(inArray(benchmarkRuns.status, ['running', 'checking']))
      .all()) {
      active.set(row.benchmarkId, (active.get(row.benchmarkId) ?? 0) + 1)
    }
    for (const id of this.launching) {
      const run = pending.find((entry) => entry.run.id === id)
      if (run) active.set(run.benchmark.id, (active.get(run.benchmark.id) ?? 0) + 1)
    }

    // Rounds across the lineup, in its order: with one slot, every variant runs once before any
    // runs twice, and the order the user chose (worst first, say) is the order runs start.
    const positions = new Map<string, Map<string, number>>()
    const positionOf = (benchmark: BenchmarkRow, variantId: string) => {
      let lineup = positions.get(benchmark.id)
      if (!lineup) {
        lineup = new Map(storedVariants(benchmark.variants).map((variant, index) => [variant.id, index]))
        positions.set(benchmark.id, lineup)
      }
      return lineup.get(variantId) ?? Number.MAX_SAFE_INTEGER
    }
    pending.sort((a, b) => a.benchmark.createdAt - b.benchmark.createdAt
      || a.benchmark.id.localeCompare(b.benchmark.id)
      || a.run.repetition - b.run.repetition
      || positionOf(a.benchmark, a.run.variantId) - positionOf(b.benchmark, b.run.variantId))

    for (const { run, benchmark } of pending) {
      if (this.launching.has(run.id)) continue
      const limit = benchmark.maxConcurrentRuns ?? (benchmark.concurrency === 'parallel' ? 4 : 1)
      if ((active.get(benchmark.id) ?? 0) >= limit) continue
      active.set(benchmark.id, (active.get(benchmark.id) ?? 0) + 1)
      // Do not await: CLI startup takes seconds and other benchmarks must not wait for it.
      detach(this.launch(run, benchmark), 'benchmark run launch')
    }
  }

  private async launch(run: BenchmarkRunRow, benchmark: BenchmarkRow): Promise<void> {
    this.launching.add(run.id)
    const startedAt = Date.now()
    const claimed: string[] = []
    try {
      const variant = readVariants(benchmark.variants).find((entry) => entry.id === run.variantId)
      if (!variant) throw new Error(`Variant ${run.variantId} is missing from the benchmark.`)
      const adapter = this.registry.adapter(variant.config.agent)
      const cli = await adapter.cli.status()
      const repetition = benchmark.repetitions > 1 ? ` · ${run.repetition}` : ''
      const title = `${benchmark.name} · ${variant.label}${repetition}`
      const workspace = createPersonalWorkspace(this.ctx.db, join(this.ctx.config.paths.data, 'discussions'), benchmark.userId, title)

      // Fresh attachment rows per run, sent the way the composer sends them: the agent sees the
      // same message shape it would in a discussion, and deleting the run removes its copies.
      const files: OutgoingAttachment[] = []
      for (const input of readInputs(benchmark.inputs)) {
        const content = await readFile(join(benchmarkInputDir(this.ctx.config.paths.data, benchmark.id), input.storedAs))
        const saved = await this.attachments.save({ userId: benchmark.userId, filename: input.filename, content })
        claimed.push(saved.id)
        const row = this.attachments.get(saved.id)!
        files.push({ id: row.id, filename: row.filename, mimeType: row.mimeType, sizeBytes: row.sizeBytes, path: row.storagePath, inlineImage: isInlineImage(row.mimeType) })
      }

      const conversation = await createConversation(this.ctx.db, this.sessions, {
        projectId: null,
        workspaceId: workspace.id,
        userId: benchmark.userId,
        agent: variant.config.agent,
        config: variant.config,
        worktreeId: null,
        cardId: null,
        title,
        origin: null,
        benchmarkId: benchmark.id,
        firstMessage: { clientMessageId: randomUUID(), text: benchmark.prompt, attachments: files, mentions: [], skills: [] },
      })
      this.attachments.claim(claimed, conversation.id)
      claimed.length = 0
      await this.recordStart(run.id, conversation.id, startedAt, cli.found ? cli.version : null)
    } catch (err) {
      for (const id of claimed) await this.attachments.remove(id)
      const message = err instanceof Error ? err.message : String(err)
      this.ctx.db
        .update(benchmarkRuns)
        .set({ status: 'failed', startedAt, finishedAt: Date.now(), error: `Launch failed: ${message}` })
        .where(and(eq(benchmarkRuns.id, run.id), eq(benchmarkRuns.status, 'pending')))
        .run()
      this.logger?.warn({ err, run: run.id }, 'benchmark run failed to launch')
    } finally {
      this.launching.delete(run.id)
      this.touch(benchmark.id, Date.now())
    }
  }

  /**
   * Marks a run as running once its session exists. A cancel during the CLI's startup already
   * closed the row: the session must not keep working unmeasured, and the run must say it opened
   * one, so it counts as started from then on.
   */
  private async recordStart(runId: string, conversationId: string, startedAt: number, cliVersion: string | null): Promise<void> {
    const started = this.ctx.db
      .update(benchmarkRuns)
      .set({ status: 'running', startedAt, conversationId, cliVersion, previewToken: randomBytes(24).toString('base64url') })
      .where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, 'pending')))
      .run()
    if (started.changes > 0) return
    const kept = this.ctx.db.update(benchmarkRuns).set({ conversationId, startedAt, cliVersion }).where(eq(benchmarkRuns.id, runId)).run()
    await this.sessions.terminate(conversationId)
    // The run is gone with its benchmark or its variant: nothing would ever list or delete the
    // thread just opened for it, so it goes now, with its attachment copies.
    if (kept.changes === 0) await deleteConversation(this.ctx.db, this.sessions, this.attachments, conversationId)
  }

  // --- Settling ------------------------------------------------------------------

  /** Same completion rule as scheduled runs: no turn, background work or loop remains. Idle threads without a verdict are still starting; overlong ones are terminated. */
  private async settle(now: number): Promise<void> {
    const open = this.ctx.db
      .select({ run: benchmarkRuns, benchmark: benchmarks })
      .from(benchmarkRuns)
      .innerJoin(benchmarks, eq(benchmarks.id, benchmarkRuns.benchmarkId))
      .where(eq(benchmarkRuns.status, 'running'))
      .all()

    for (const { run, benchmark } of open) {
      const thread = run.conversationId
        ? this.ctx.db
            .select({ status: conversations.status, background: conversations.backgroundCount, loops: conversations.loopCount })
            .from(conversations)
            .where(eq(conversations.id, run.conversationId))
            .get()
        : undefined
      if (!run.conversationId || !thread) {
        await this.close(run, { status: 'failed', error: 'The run conversation was deleted before completion.' }, now)
        continue
      }

      const working = thread.status === 'running' || thread.status === 'awaiting_input' || thread.background > 0 || thread.loops > 0
      const dead = thread.status === 'interrupted' || thread.status === 'error'
      const [verdict] = working ? [] : this.log.latest(run.conversationId, ['turn.completed', 'error'], 1)

      let outcome: Outcome
      if (working || (!verdict && !dead)) {
        const limit = benchmark.maxDurationMinutes * 60_000
        // Each attempt has the whole duration: a follow-up sent days later starts its own.
        const attemptStart = readFollowUps(run.followUps).at(-1)?.sentAt ?? run.startedAt ?? now
        const elapsed = now - attemptStart
        // The limit bounds the agent's work, not the user's absence: time a request spent waiting
        // for an answer is given back, so a run that asked at night still finishes once answered.
        if (elapsed < limit || elapsed - readWaitingMs(this.log, run.conversationId, now, attemptStart) < limit) continue
        const reason = `Maximum duration reached (${benchmark.maxDurationMinutes} min): the run was interrupted.`
        this.log.append(run.conversationId, { type: 'error', code: 'benchmark_timeout', message: reason, recoverable: true })
        await this.sessions.terminate(run.conversationId)
        outcome = { status: 'timed_out', error: reason }
      } else if (thread.status === 'interrupted') {
        outcome = { status: 'failed', error: 'Run interrupted before completion (manual stop or Sillage restart).' }
      } else if (thread.status === 'error' || verdict?.event.type === 'error') {
        outcome = { status: 'failed', error: verdict?.event.type === 'error' ? verdict.event.message : 'The CLI ended in error.' }
      } else {
        outcome = { status: 'succeeded', error: null }
      }

      if (benchmark.checkScript) {
        // Do not await: a script may take minutes and other runs must keep settling meanwhile.
        this.ctx.db.update(benchmarkRuns).set({ status: 'checking' }).where(eq(benchmarkRuns.id, run.id)).run()
        detach(this.check(run, benchmark, outcome), 'benchmark run check')
        continue
      }
      await this.close(run, outcome, now)
    }
  }

  /** Runs the benchmark's script in the run folder, then closes the run with its verdict. */
  private async check(run: BenchmarkRunRow, benchmark: BenchmarkRow, outcome: Outcome): Promise<void> {
    let result: BenchmarkCheckResult | null = null
    const scratch = join(this.ctx.config.paths.data, 'benchmarks', benchmark.id, 'checks', run.id)
    try {
      const folder = run.conversationId ? this.runFolder(run.conversationId) : null
      if (folder) {
        await mkdir(scratch, { recursive: true })
        // The answer goes beside, not inside, the folder: deliverables must stay what the agent wrote.
        const responseFile = join(scratch, 'response.txt')
        await writeFile(responseFile, run.conversationId ? (this.log.lastAssistantText(run.conversationId) ?? '') : '')
        const variant = readVariants(benchmark.variants).find((entry) => entry.id === run.variantId)
        const script = await runScript(benchmark.checkScript ?? '', {
          cwd: folder,
          description: `${benchmark.name} · ${variant?.label ?? run.variantId}`,
          timeoutMs: benchmark.checkTimeoutSeconds * 1000,
          env: {
            SILLAGE_BENCHMARK_ID: benchmark.id,
            SILLAGE_BENCHMARK_NAME: benchmark.name,
            SILLAGE_RUN_ID: run.id,
            SILLAGE_RUN_DIR: folder,
            SILLAGE_RUN_STATUS: outcome.status,
            SILLAGE_RESPONSE_FILE: responseFile,
            SILLAGE_VARIANT_ID: run.variantId,
            SILLAGE_VARIANT: variant?.label ?? '',
            SILLAGE_AGENT: variant?.config.agent ?? '',
            SILLAGE_MODEL: variant?.config.model ?? '',
            SILLAGE_EFFORT: (variant && variantEffort(variant.config)) ?? '',
            SILLAGE_REPETITION: String(run.repetition),
          },
        })
        result = { ...script, passed: !script.timedOut && script.exitCode === 0 }
      }
    } catch (err) {
      this.logger?.warn({ err, run: run.id }, 'benchmark check failed to run')
      result = { passed: false, exitCode: null, timedOut: false, stdout: '', stderr: err instanceof Error ? err.message : String(err), durationMs: 0 }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    await this.close(run, outcome, Date.now(), undefined, undefined, result)
  }

  private runFolder(conversationId: string): string | null {
    const row = this.ctx.db
      .select({ path: personalWorkspaces.path })
      .from(conversations)
      .innerJoin(personalWorkspaces, eq(personalWorkspaces.id, conversations.workspaceId))
      .where(eq(conversations.id, conversationId))
      .get()
    return row?.path ?? null
  }

  /** Measurements are folded for every outcome: a failed run's token count is still a cost. */
  private async close(
    run: BenchmarkRunRow,
    outcome: Outcome,
    now: number,
    status: BenchmarkRunRow['status'] = outcome.status,
    error: string | null = outcome.error,
    check: BenchmarkCheckResult | null = null,
  ): Promise<void> {
    // Cancellation/timeout can emit final usage while terminate() is awaited after the sweep.
    now = Math.max(now, Date.now())
    let metrics: string | null = null
    let response: string | null = null
    let files: string | null = null
    if (run.conversationId) {
      try {
        metrics = JSON.stringify(readRunMetrics(this.log, run.conversationId, undefined, now))
        const text = this.log.lastAssistantText(run.conversationId)
        response = text ? text.slice(0, MAX_RESPONSE_CHARS) : null
        const folder = this.runFolder(run.conversationId)
        if (folder) files = JSON.stringify(await listDeliverables(folder))
      } catch (err) {
        this.logger?.warn({ err, run: run.id }, 'benchmark results could not be collected')
      }
    }
    this.ctx.db
      .update(benchmarkRuns)
      .set({ status, finishedAt: now, error, metrics, response, files, check: check ? JSON.stringify(check) : null })
      .where(eq(benchmarkRuns.id, run.id))
      .run()
    this.touch(run.benchmarkId, now)
  }

  private touch(benchmarkId: string, now: number): void {
    this.ctx.db.update(benchmarks).set({ updatedAt: now }).where(eq(benchmarks.id, benchmarkId)).run()
  }

  // --- Reads ---------------------------------------------------------------------

  list(userId: string): BenchmarkDto[] {
    const rows = this.ctx.db.select().from(benchmarks).where(eq(benchmarks.userId, userId)).orderBy(desc(benchmarks.createdAt)).all()
    return benchmarksToDto(this.ctx.db, rows, this.prices)
  }

  /** One benchmark as the interface, the exports and the share pages read it. */
  dto(row: BenchmarkRow): BenchmarkDto {
    return benchmarksToDto(this.ctx.db, [row], this.prices)[0]!
  }

  load(id: string, userId: string): BenchmarkRow {
    const row = this.ctx.db.select().from(benchmarks).where(and(eq(benchmarks.id, id), eq(benchmarks.userId, userId))).get()
    if (!row) throw notFound('benchmark_not_found', 'Benchmark not found.')
    return row
  }
}
