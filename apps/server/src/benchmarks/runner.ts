import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  benchmarkRuns,
  benchmarks,
  conversations,
  writeTransaction,
  type BenchmarkRow,
  type BenchmarkRunRow,
  type Db,
} from '@sillage/db'
import {
  MAX_PARALLEL_BENCHMARK_RUNS,
  benchmarkVariantsSchema,
  defaultVariantLabel,
  type BenchmarkDto,
  type BenchmarkRunDto,
  type BenchmarkRunMetrics,
  type BenchmarkVariant,
  type CreateBenchmarkBody,
} from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import type { AttachmentStore } from '../attachments/store.js'
import { createConversation } from '../conversations/create.js'
import { deleteConversation } from '../conversations/delete.js'
import type { EventLog } from '../events/event-log.js'
import type { AppContext } from '../http/context.js'
import { notFound } from '../http/errors.js'
import type { SessionManager } from '../sessions/session-manager.js'
import { readRunMetrics } from './metrics.js'

/**
 * Executes benchmarks: opens one fresh personal session per run, waits for it to settle, folds
 * its journal into measurements. Sweeps database state like `TaskScheduler` rather than holding
 * runs in memory: a restart interrupts sessions but leaves pending runs to launch afterwards, and
 * every sweep decides from rows what to start next.
 */

const TICK_MS = 5000

export function readVariants(raw: string): BenchmarkVariant[] {
  return benchmarkVariantsSchema.parse(JSON.parse(raw))
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
    metrics: row.metrics ? (JSON.parse(row.metrics) as BenchmarkRunMetrics) : null,
  }
}

export function benchmarksToDto(db: Db, rows: BenchmarkRow[]): BenchmarkDto[] {
  if (rows.length === 0) return []
  const runs = db
    .select()
    .from(benchmarkRuns)
    .where(inArray(benchmarkRuns.benchmarkId, rows.map((row) => row.id)))
    .orderBy(asc(benchmarkRuns.variantId), asc(benchmarkRuns.repetition))
    .all()
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    variants: readVariants(row.variants),
    repetitions: row.repetitions,
    concurrency: row.concurrency,
    maxDurationMinutes: row.maxDurationMinutes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    runs: runs.filter((run) => run.benchmarkId === row.id).map(runToDto),
  }))
}

export class BenchmarkRunner {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private again = false
  private logger: FastifyBaseLogger | null = null
  /** Runs whose CLI is starting: a sweep during those seconds must not launch them twice. */
  private readonly launching = new Set<string>()

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    private readonly registry: AgentRegistry,
    private readonly log: EventLog,
    private readonly attachments: AttachmentStore,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    this.timer = setInterval(() => void this.tick(), TICK_MS)
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
    void this.tick()
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
      setImmediate(() => void this.tick())
    }
  }

  /** Resolves CLI defaults before writing: frozen variants must name the model that actually ran. */
  async create(userId: string, body: CreateBenchmarkBody): Promise<BenchmarkRow> {
    const variants: BenchmarkVariant[] = []
    for (const [index, input] of body.variants.entries()) {
      this.sessions.assertCliEnabled(input.config.agent)
      const config = await this.registry.adapter(input.config.agent).resolveDefaults(input.config)
      variants.push({ id: `v${index + 1}`, label: input.label ?? defaultVariantLabel(config), config })
    }
    const now = Date.now()
    const row: BenchmarkRow = {
      id: randomUUID(),
      userId,
      name: body.name,
      prompt: body.prompt,
      variants: JSON.stringify(variants),
      repetitions: body.repetitions,
      concurrency: body.concurrency,
      maxDurationMinutes: body.maxDurationMinutes,
      createdAt: now,
      updatedAt: now,
    }
    writeTransaction(this.ctx.db, (tx) => {
      tx.insert(benchmarks).values(row).run()
      for (const variant of variants) {
        for (let repetition = 1; repetition <= body.repetitions; repetition += 1) {
          tx.insert(benchmarkRuns)
            .values({
              id: randomUUID(),
              benchmarkId: row.id,
              variantId: variant.id,
              repetition,
              conversationId: null,
              status: 'pending',
              startedAt: null,
              finishedAt: null,
              error: null,
              metrics: null,
            })
            .run()
        }
      }
    })
    this.kick()
    return row
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
      this.close(run, 'cancelled', now, 'Cancelled by the user.')
    }
    this.touch(benchmarkId, now)
  }

  /** Runs' conversations go with the benchmark: they were opened to be measured, not to be continued. Their folders stay, like any discussion's. */
  async delete(benchmarkId: string): Promise<void> {
    await this.cancel(benchmarkId)
    const threads = this.ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.benchmarkId, benchmarkId))
      .all()
    for (const thread of threads) await deleteConversation(this.ctx.db, this.sessions, this.attachments, thread.id)
    this.ctx.db.delete(benchmarks).where(eq(benchmarks.id, benchmarkId)).run()
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

    const active = new Map<string, number>()
    for (const row of this.ctx.db
      .select({ benchmarkId: benchmarkRuns.benchmarkId })
      .from(benchmarkRuns)
      .where(eq(benchmarkRuns.status, 'running'))
      .all()) {
      active.set(row.benchmarkId, (active.get(row.benchmarkId) ?? 0) + 1)
    }
    for (const id of this.launching) {
      const run = pending.find((entry) => entry.run.id === id)
      if (run) active.set(run.benchmark.id, (active.get(run.benchmark.id) ?? 0) + 1)
    }

    for (const { run, benchmark } of pending) {
      if (this.launching.has(run.id)) continue
      const limit = benchmark.concurrency === 'parallel' ? MAX_PARALLEL_BENCHMARK_RUNS : 1
      if ((active.get(benchmark.id) ?? 0) >= limit) continue
      active.set(benchmark.id, (active.get(benchmark.id) ?? 0) + 1)
      // Do not await: CLI startup takes seconds and other benchmarks must not wait for it.
      void this.launch(run, benchmark)
    }
  }

  private async launch(run: BenchmarkRunRow, benchmark: BenchmarkRow): Promise<void> {
    this.launching.add(run.id)
    const startedAt = Date.now()
    try {
      const variant = readVariants(benchmark.variants).find((entry) => entry.id === run.variantId)
      if (!variant) throw new Error(`Variant ${run.variantId} is missing from the benchmark.`)
      const repetition = benchmark.repetitions > 1 ? ` · ${run.repetition}` : ''
      const row = await createConversation(this.ctx.db, this.sessions, {
        projectId: null,
        workspaceRoot: join(this.ctx.config.paths.data, 'discussions'),
        userId: benchmark.userId,
        agent: variant.config.agent,
        config: variant.config,
        worktreeId: null,
        cardId: null,
        title: `${benchmark.name} · ${variant.label}${repetition}`,
        origin: null,
        benchmarkId: benchmark.id,
        firstMessage: {
          clientMessageId: randomUUID(),
          text: benchmark.prompt,
          attachments: [],
          mentions: [],
          skills: [],
        },
      })
      this.ctx.db
        .update(benchmarkRuns)
        .set({ status: 'running', startedAt, conversationId: row.id })
        .where(and(eq(benchmarkRuns.id, run.id), eq(benchmarkRuns.status, 'pending')))
        .run()
    } catch (err) {
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

  // --- Settling ------------------------------------------------------------------

  /** Same completion rule as scheduled runs: no turn, background work or loop remains. Idle threads without a verdict are still starting; overlong ones are terminated. */
  private async settle(now: number): Promise<void> {
    const open = this.ctx.db
      .select({ run: benchmarkRuns, maxDurationMinutes: benchmarks.maxDurationMinutes })
      .from(benchmarkRuns)
      .innerJoin(benchmarks, eq(benchmarks.id, benchmarkRuns.benchmarkId))
      .where(eq(benchmarkRuns.status, 'running'))
      .all()

    for (const { run, maxDurationMinutes } of open) {
      const thread = run.conversationId
        ? this.ctx.db
            .select({ status: conversations.status, background: conversations.backgroundCount, loops: conversations.loopCount })
            .from(conversations)
            .where(eq(conversations.id, run.conversationId))
            .get()
        : undefined
      if (!run.conversationId || !thread) {
        this.close(run, 'failed', now, 'The run conversation was deleted before completion.')
        continue
      }

      const working = thread.status === 'running' || thread.status === 'awaiting_input' || thread.background > 0 || thread.loops > 0
      const dead = thread.status === 'interrupted' || thread.status === 'error'
      const [verdict] = working ? [] : this.log.latest(run.conversationId, ['turn.completed', 'error'], 1)

      if (working || (!verdict && !dead)) {
        if (now - (run.startedAt ?? now) < maxDurationMinutes * 60_000) continue
        const reason = `Maximum duration reached (${maxDurationMinutes} min): the run was interrupted.`
        this.log.append(run.conversationId, { type: 'error', code: 'benchmark_timeout', message: reason, recoverable: true })
        await this.sessions.terminate(run.conversationId)
        this.close(run, 'timed_out', now, reason)
        continue
      }

      if (thread.status === 'interrupted') {
        this.close(run, 'failed', now, 'Run interrupted before completion (manual stop or Sillage restart).')
      } else if (thread.status === 'error' || verdict?.event.type === 'error') {
        this.close(run, 'failed', now, verdict?.event.type === 'error' ? verdict.event.message : 'The CLI ended in error.')
      } else {
        this.close(run, 'succeeded', now, null)
      }
    }
  }

  /** Measurements are folded for every outcome: a failed run's token count is still a cost. */
  private close(run: BenchmarkRunRow, status: BenchmarkRunRow['status'], now: number, error: string | null): void {
    let metrics: string | null = null
    if (run.conversationId) {
      try {
        metrics = JSON.stringify(readRunMetrics(this.log, run.conversationId))
      } catch (err) {
        this.logger?.warn({ err, run: run.id }, 'benchmark metrics could not be folded')
      }
    }
    this.ctx.db
      .update(benchmarkRuns)
      .set({ status, finishedAt: now, error, metrics })
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
    return benchmarksToDto(this.ctx.db, rows)
  }

  load(id: string, userId: string): BenchmarkRow {
    const row = this.ctx.db.select().from(benchmarks).where(and(eq(benchmarks.id, id), eq(benchmarks.userId, userId))).get()
    if (!row) throw notFound('benchmark_not_found', 'Benchmark not found.')
    return row
  }
}
