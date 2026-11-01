import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  benchmarkRuns,
  benchmarks,
  conversations,
  personalWorkspaces,
  writeTransaction,
  type BenchmarkRow,
  type BenchmarkRunRow,
  type Db,
} from '@sillage/db'
import {
  MAX_PARALLEL_BENCHMARK_RUNS,
  benchmarkInputsSchema,
  benchmarkSeriesRoot,
  benchmarkVariantsSchema,
  defaultVariantLabel,
  variantEffort,
  type BenchmarkCheckResult,
  type BenchmarkDeliverable,
  type BenchmarkDto,
  type BenchmarkInput,
  type BenchmarkRunDto,
  type BenchmarkRunMetrics,
  type BenchmarkVariant,
  type CreateBenchmarkData,
} from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import type { OutgoingAttachment } from '../agents/types.js'
import { isInlineImage, type AttachmentStore } from '../attachments/store.js'
import { createConversation } from '../conversations/create.js'
import { deleteConversation } from '../conversations/delete.js'
import { createPersonalWorkspace } from '../conversations/personal-workspaces.js'
import type { EventLog } from '../events/event-log.js'
import type { AppContext } from '../http/context.js'
import { badRequest, notFound } from '../http/errors.js'
import { runScript } from '../scheduler/check.js'
import type { SessionManager } from '../sessions/session-manager.js'
import { listDeliverables } from './deliverables.js'
import { readRunMetrics } from './metrics.js'

/**
 * Executes benchmarks: opens one fresh personal session per run, waits for it to settle, runs the
 * benchmark's script in its folder, folds its journal into measurements. Sweeps database state
 * like `TaskScheduler` rather than holding runs in memory: a restart interrupts sessions but
 * leaves pending runs to launch afterwards, and every sweep decides from rows what to start next.
 */

const TICK_MS = 5000

/** Answers longer than this are rare and stay whole in the run's conversation. */
const MAX_RESPONSE_CHARS = 20000

export function readVariants(raw: string): BenchmarkVariant[] {
  return benchmarkVariantsSchema.parse(JSON.parse(raw))
}

function readInputs(raw: string): BenchmarkInput[] {
  return benchmarkInputsSchema.parse(JSON.parse(raw))
}

/** Starting files live beside the database, never in a run folder an agent may rewrite. */
export function benchmarkInputDir(dataDir: string, benchmarkId: string): string {
  return join(dataDir, 'benchmarks', benchmarkId, 'inputs')
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
    inputs: readInputs(row.inputs).map(({ filename, mimeType, sizeBytes }) => ({ filename, mimeType, sizeBytes })),
    checkScript: row.checkScript,
    checkTimeoutSeconds: row.checkTimeoutSeconds,
    seriesId: row.seriesId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    runs: runs.filter((run) => run.benchmarkId === row.id).map(runToDto),
  }))
}

type Outcome = { status: 'succeeded' | 'failed' | 'timed_out'; error: string | null }

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
    // A script killed with the previous process never reported: settle those runs again, which
    // reruns the script against the folder the session left.
    this.ctx.db.update(benchmarkRuns).set({ status: 'running' }).where(eq(benchmarkRuns.status, 'checking')).run()
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
  async create(userId: string, body: CreateBenchmarkData): Promise<BenchmarkRow> {
    const variants: BenchmarkVariant[] = []
    for (const [index, input] of body.variants.entries()) {
      this.sessions.assertCliEnabled(input.config.agent)
      const config = await this.registry.adapter(input.config.agent).resolveDefaults(input.config)
      variants.push({ id: `v${index + 1}`, label: input.label ?? defaultVariantLabel(config), config })
    }

    const id = randomUUID()
    const uploads = this.attachments.listClaimable(userId, body.attachmentIds)
    const missing = body.attachmentIds.find((attachmentId) => !uploads.some((row) => row.id === attachmentId))
    if (missing) throw badRequest('attachment_unavailable', 'Attachment {id} is unavailable or has already been sent.', { id: missing })
    // Copy uploads under the benchmark: each run will turn them into its own attachments, and the
    // originals are released below rather than claimed by a single conversation.
    const inputs: BenchmarkInput[] = []
    const inputDir = benchmarkInputDir(this.ctx.config.paths.data, id)
    if (uploads.length > 0) await mkdir(inputDir, { recursive: true })
    for (const [index, attachmentId] of body.attachmentIds.entries()) {
      const upload = uploads.find((row) => row.id === attachmentId)!
      const storedAs = `${index + 1}-${upload.filename.replace(/[\\/]/g, '_')}`
      await copyFile(upload.storagePath, join(inputDir, storedAs))
      inputs.push({ storedAs, filename: upload.filename, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes })
    }

    const now = Date.now()
    const row: BenchmarkRow = {
      id,
      userId,
      name: body.name,
      prompt: body.prompt,
      variants: JSON.stringify(variants),
      repetitions: body.repetitions,
      concurrency: body.concurrency,
      maxDurationMinutes: body.maxDurationMinutes,
      inputs: JSON.stringify(inputs),
      checkScript: body.checkScript,
      checkTimeoutSeconds: body.checkTimeoutSeconds,
      seriesId: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.insert(row, variants)
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
    const row: BenchmarkRow = { ...source, id, seriesId: benchmarkSeriesRoot(source), createdAt: now, updatedAt: now }
    await this.insert(row, variants)
    this.kick()
    return row
  }

  /** Writes a benchmark with one pending run per variant and repetition; removes its files if that fails. */
  private async insert(row: BenchmarkRow, variants: BenchmarkVariant[]): Promise<void> {
    try {
      writeTransaction(this.ctx.db, (tx) => {
        tx.insert(benchmarks).values(row).run()
        for (const variant of variants) {
          for (let repetition = 1; repetition <= row.repetitions; repetition += 1) {
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
                cliVersion: null,
                metrics: null,
                response: null,
                check: null,
                files: null,
                previewToken: null,
                rating: null,
                ratingNote: null,
                ratedAt: null,
              })
              .run()
          }
        }
      })
    } catch (err) {
      await rm(join(this.ctx.config.paths.data, 'benchmarks', row.id), { recursive: true, force: true })
      throw err
    }
  }

  /** Records a human rating. Allowed before settlement too: a page can be judged while the check runs. */
  rate(benchmarkId: string, runId: string, rating: number | null, note: string | null): void {
    const result = this.ctx.db
      .update(benchmarkRuns)
      .set({ rating, ratingNote: rating === null ? null : note, ratedAt: rating === null ? null : Date.now() })
      .where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.benchmarkId, benchmarkId)))
      .run()
    if (result.changes === 0) throw notFound('benchmark_run_not_found', 'Benchmark run not found.')
    this.touch(benchmarkId, Date.now())
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
    const threads = this.ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.benchmarkId, benchmarkId))
      .all()
    for (const thread of threads) await deleteConversation(this.ctx.db, this.sessions, this.attachments, thread.id)
    this.ctx.db.delete(benchmarks).where(eq(benchmarks.id, benchmarkId)).run()
    await rm(join(this.ctx.config.paths.data, 'benchmarks', benchmarkId), { recursive: true, force: true })
  }

  /** Folder of a launched run, for the preview route. Null for unknown tokens or deleted threads. */
  previewRoot(token: string): string | null {
    const row = this.ctx.db
      .select({ path: personalWorkspaces.path })
      .from(benchmarkRuns)
      .innerJoin(conversations, eq(conversations.id, benchmarkRuns.conversationId))
      .innerJoin(personalWorkspaces, eq(personalWorkspaces.id, conversations.workspaceId))
      .where(eq(benchmarkRuns.previewToken, token))
      .get()
    return row?.path ?? null
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
      this.ctx.db
        .update(benchmarkRuns)
        .set({
          status: 'running',
          startedAt,
          conversationId: conversation.id,
          cliVersion: cli.found ? cli.version : null,
          previewToken: randomBytes(24).toString('base64url'),
        })
        .where(and(eq(benchmarkRuns.id, run.id), eq(benchmarkRuns.status, 'pending')))
        .run()
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
        if (now - (run.startedAt ?? now) < benchmark.maxDurationMinutes * 60_000) continue
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
        void this.check(run, benchmark, outcome)
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
    let metrics: string | null = null
    let response: string | null = null
    let files: string | null = null
    if (run.conversationId) {
      try {
        metrics = JSON.stringify(readRunMetrics(this.log, run.conversationId))
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
    return benchmarksToDto(this.ctx.db, rows)
  }

  load(id: string, userId: string): BenchmarkRow {
    const row = this.ctx.db.select().from(benchmarks).where(and(eq(benchmarks.id, id), eq(benchmarks.userId, userId))).get()
    if (!row) throw notFound('benchmark_not_found', 'Benchmark not found.')
    return row
  }
}
