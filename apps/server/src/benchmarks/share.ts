import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'
import { benchmarkShares } from '@sillage/db'
import {
  BENCHMARK_SHARE_PREFIX,
  MAX_BENCHMARK_SHARE_BYTES,
  deliverableKind,
  type BenchmarkDto,
  type BenchmarkRunExportability,
  type BenchmarkShareDto,
  type BenchmarkShareOptions,
  type BenchmarkShareStateDto,
} from '@sillage/protocol'
import { publicShareRoot } from '../exports/public-root.js'
import type { AppContext } from '../http/context.js'
import { HttpError, badRequest, notFound } from '../http/errors.js'
import { INSTANCE_PROFILE, instanceCapabilities } from '../instance/profile.js'
import type { ArchiveItem } from '../workspace-archive.js'
import { assessRunFolder, type RunAssessment } from './exportability.js'
import { benchmarksToDto, type BenchmarkRunner } from './runner.js'
import { renderBenchmarkShare, type SharePage, type SharePageRun } from './share-page.js'

/** Text shown inline for a run without a page: enough to read a short file, not a whole log. */
const EXCERPT_BYTES = 16 * 1024
const MAX_EXCERPTS_PER_RUN = 8

const UNSETTLED = new Set(['pending', 'running', 'checking'])

interface Composition {
  page: SharePage
  /** Files to place beside the page: `target` is relative to it. */
  copies: { source: string; target: string }[]
}

/**
 * Shared benchmarks: a frozen page with a copy of the productions that work as plain files. One
 * composition feeds both ways out, the public link and the archive, so a friend sees the same
 * page either way.
 */
export class BenchmarkShares {
  /** Snapshots being written have no row yet: the sweep must not take them for leftovers. */
  private readonly publishing = new Set<string>()

  constructor(
    private readonly ctx: AppContext,
    private readonly runner: BenchmarkRunner,
    private readonly publicSharing = instanceCapabilities(INSTANCE_PROFILE).publicConversationSharing,
  ) {}

  private get directory(): string {
    return join(this.ctx.config.paths.data, 'benchmark-shares')
  }

  private root(): string {
    return publicShareRoot(this.ctx, this.publicSharing)
  }

  private benchmark(id: string, userId: string): BenchmarkDto {
    return benchmarksToDto(this.ctx.db, [this.runner.load(id, userId)])[0]!
  }

  private async assess(benchmark: BenchmarkDto): Promise<Map<string, RunAssessment>> {
    const result = new Map<string, RunAssessment>()
    for (const run of benchmark.runs) {
      if (UNSETTLED.has(run.status)) {
        result.set(run.id, { mode: 'none', reason: 'unfinished', entry: null, files: [], bytes: 0 })
        continue
      }
      result.set(run.id, await assessRunFolder(run.previewToken ? this.runner.previewRoot(run.previewToken) : null))
    }
    return result
  }

  private shareDto(row: typeof benchmarkShares.$inferSelect): BenchmarkShareDto {
    const root = this.root()
    return {
      id: row.id,
      title: row.title,
      url: root ? `${root}${BENCHMARK_SHARE_PREFIX}${row.id}/` : null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }
  }

  private activeRows(benchmarkId: string) {
    return this.ctx.db
      .select()
      .from(benchmarkShares)
      .where(
        and(
          eq(benchmarkShares.benchmarkId, benchmarkId),
          isNull(benchmarkShares.revokedAt),
          or(isNull(benchmarkShares.expiresAt), gt(benchmarkShares.expiresAt, Date.now())),
        ),
      )
      .orderBy(desc(benchmarkShares.createdAt))
      .all()
  }

  async state(benchmarkId: string, userId: string): Promise<BenchmarkShareStateDto> {
    const benchmark = this.benchmark(benchmarkId, userId)
    void this.sweep().catch(() => {})
    const assessments = await this.assess(benchmark)
    const runs: BenchmarkRunExportability[] = benchmark.runs.map((run) => {
      const verdict = assessments.get(run.id)!
      return { runId: run.id, mode: verdict.mode, reason: verdict.reason, entry: verdict.entry, files: verdict.files.length, bytes: verdict.bytes }
    })
    return { canPublish: !!this.root(), runs, shares: this.activeRows(benchmarkId).map((row) => this.shareDto(row)) }
  }

  private async compose(benchmark: BenchmarkDto, options: BenchmarkShareOptions): Promise<Composition> {
    const assessments = await this.assess(benchmark)
    const order = benchmark.variants.map((variant) => variant.id)
    // A blind page must not give the answer away by listing variants in the order they were set up.
    if (options.blind) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = randomBytes(1)[0]! % (i + 1)
        ;[order[i], order[j]] = [order[j]!, order[i]!]
      }
    }

    const copies: Composition['copies'] = []
    const runs: SharePageRun[] = []
    let bytes = 0
    let folder = 0
    // Folders are numbered in display order: a name derived from the variant would unblind the page.
    const sorted = [...benchmark.runs].sort(
      (a, b) => a.repetition - b.repetition || order.indexOf(a.variantId) - order.indexOf(b.variantId),
    )
    for (const run of sorted) {
      const verdict = assessments.get(run.id)!
      const root = run.previewToken ? this.runner.previewRoot(run.previewToken) : null
      const shared = { ...run, rating: options.includeRatings ? run.rating : null, ratingNote: null, conversationId: null, previewToken: null }
      if (verdict.mode === 'none' || !root) {
        runs.push({ run: shared, mode: 'none', reason: verdict.reason ?? 'missing', dir: null, entry: null, files: [], excerpts: {} })
        continue
      }
      const dir = `runs/${++folder}`
      bytes += verdict.bytes
      if (bytes > MAX_BENCHMARK_SHARE_BYTES) {
        throw new HttpError(413, 'benchmark_share_too_large', 'The productions are too large to share together (maximum {maxMb} MB).', {
          maxMb: MAX_BENCHMARK_SHARE_BYTES / 1024 / 1024,
        })
      }
      const excerpts: Record<string, string> = {}
      if (verdict.mode === 'files') {
        const texts = verdict.files.filter((file) => deliverableKind(file.path) === 'text').slice(0, MAX_EXCERPTS_PER_RUN)
        for (const file of texts) excerpts[file.path] = await excerpt(join(root, file.path))
      }
      for (const file of verdict.files) copies.push({ source: join(root, file.path), target: `${dir}/${file.path}` })
      runs.push({ run: shared, mode: verdict.mode, reason: null, dir, entry: verdict.entry, files: verdict.files, excerpts })
    }
    return { page: { benchmark, options, runs, order, sharedAt: Date.now() }, copies }
  }

  /** Publishes a snapshot: later runs, ratings or cleanups never change what the link shows. */
  async publish(benchmarkId: string, userId: string, options: BenchmarkShareOptions, expiresAt: number | null): Promise<BenchmarkShareDto> {
    if (!this.root()) throw badRequest('benchmark_share_unavailable', 'Public sharing is unavailable on this instance.')
    if (expiresAt !== null && expiresAt <= Date.now()) throw badRequest('export_expiry', 'Expiration must be in the future.')
    const benchmark = this.benchmark(benchmarkId, userId)
    const { page, copies } = await this.compose(benchmark, options)

    const id = randomBytes(24).toString('base64url')
    const target = join(this.directory, id)
    this.publishing.add(id)
    try {
      await mkdir(target, { recursive: true, mode: 0o700 })
      for (const copy of copies) {
        // Regular files only, checked again at copy time: a link swapped in since the inventory
        // would otherwise publish whatever it points at.
        if (!(await lstat(copy.source).catch(() => null))?.isFile()) continue
        const destination = join(target, copy.target)
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(copy.source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      }
      await writeFile(join(target, 'index.html'), renderBenchmarkShare(page), { mode: 0o600, flag: 'wx' })
      // The benchmark may have been deleted while files were copied.
      this.runner.load(benchmarkId, userId)
      const row = { id, benchmarkId, userId, title: options.title, createdAt: page.sharedAt, expiresAt, revokedAt: null }
      this.ctx.db.insert(benchmarkShares).values(row).run()
      return this.shareDto(row)
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      throw error
    } finally {
      this.publishing.delete(id)
    }
  }

  /**
   * The same page as an archive to send or host anywhere: `index.html` beside the productions.
   * The page is written to a scratch file because the archive streams from disk; `dispose`
   * removes it once the download ends.
   */
  async archive(benchmarkId: string, userId: string, options: BenchmarkShareOptions): Promise<{ filename: string; items: ArchiveItem[]; dispose: () => Promise<void> }> {
    const benchmark = this.benchmark(benchmarkId, userId)
    const { page, copies } = await this.compose(benchmark, options)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const scratch = join(this.directory, `.page-${randomUUID()}.html`)
    await writeFile(scratch, renderBenchmarkShare(page), { mode: 0o600, flag: 'wx' })
    const mtime = new Date(page.sharedAt)
    const items: ArchiveItem[] = [
      { name: 'index.html', absolute: scratch, isDirectory: false, mtime },
      ...copies.map((copy) => ({ name: copy.target, absolute: copy.source, isDirectory: false, mtime })),
    ]
    const name = options.title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').trim() || 'benchmark'
    return { filename: `${name}.zip`, items, dispose: () => rm(scratch, { force: true }) }
  }

  async revoke(benchmarkId: string, shareId: string, userId: string): Promise<void> {
    this.runner.load(benchmarkId, userId)
    const row = this.ctx.db
      .select({ id: benchmarkShares.id })
      .from(benchmarkShares)
      .where(and(eq(benchmarkShares.id, shareId), eq(benchmarkShares.benchmarkId, benchmarkId), eq(benchmarkShares.userId, userId)))
      .get()
    if (!row) throw notFound('not_found', 'Not found.')
    this.ctx.db.update(benchmarkShares).set({ revokedAt: Date.now() }).where(eq(benchmarkShares.id, shareId)).run()
    await rm(join(this.directory, shareId), { recursive: true, force: true })
  }

  /** Called before the benchmark row goes: the cascade removes the links, not their folders. */
  async removeFor(benchmarkId: string): Promise<void> {
    const rows = this.ctx.db.select({ id: benchmarkShares.id }).from(benchmarkShares).where(eq(benchmarkShares.benchmarkId, benchmarkId)).all()
    for (const row of rows) await rm(join(this.directory, row.id), { recursive: true, force: true })
  }

  /** Folder of a live link, for the public route. Null when unknown, revoked, expired or on an edition without public links. */
  publicRoot(token: string): string | null {
    if (!this.publicSharing || !/^[a-zA-Z0-9_-]{32}$/.test(token)) return null
    const row = this.ctx.db
      .select({ id: benchmarkShares.id })
      .from(benchmarkShares)
      .where(
        and(
          eq(benchmarkShares.id, token),
          isNull(benchmarkShares.revokedAt),
          or(isNull(benchmarkShares.expiresAt), gt(benchmarkShares.expiresAt, Date.now())),
        ),
      )
      .get()
    return row ? join(this.directory, token) : null
  }

  /** Removes what no live link serves any more: expired snapshots, and scratch pages of interrupted downloads. */
  async sweep(): Promise<void> {
    const names = await readdir(this.directory).catch(() => [])
    for (const name of names) {
      const absolute = join(this.directory, name)
      if (name.startsWith('.page-')) {
        const info = await stat(absolute).catch(() => null)
        if (info && Date.now() - info.mtimeMs > 60 * 60 * 1000) await rm(absolute, { force: true })
        continue
      }
      if (this.publishing.has(name)) continue
      const live = this.ctx.db
        .select({ id: benchmarkShares.id })
        .from(benchmarkShares)
        .where(
          and(
            eq(benchmarkShares.id, name),
            isNull(benchmarkShares.revokedAt),
            or(isNull(benchmarkShares.expiresAt), gt(benchmarkShares.expiresAt, Date.now())),
          ),
        )
        .get()
      if (!live) await rm(absolute, { recursive: true, force: true })
    }
  }
}

async function excerpt(absolute: string): Promise<string> {
  const handle = await open(absolute, 'r').catch(() => null)
  if (!handle) return ''
  try {
    const buffer = Buffer.alloc(EXCERPT_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, EXCERPT_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
