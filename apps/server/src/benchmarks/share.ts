import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'
import { benchmarkShares } from '@sillage/db'
import {
  BENCHMARK_PREVIEW_PREFIX,
  BENCHMARK_SHARE_PREFIX,
  BENCHMARK_SLIDES_FILE,
  MAX_BENCHMARK_SHARE_BYTES,
  benchmarkLiveUrl,
  benchmarkShareOptionsSchema,
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
import { LIVE_LIMITS, SNAPSHOT_LIMITS, assessRunFolder, type RunAssessment, type RunFile, type WalkLimits } from './exportability.js'
import type { BenchmarkRunner } from './runner.js'
import { renderBenchmarkShare, type SharePage, type SharePageRun } from './share-page.js'
import { featuredComparisons } from './share-parts.js'
import { renderBenchmarkSlides } from './share-slides.js'

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
 * What a composition is for. A snapshot copies the productions beside the page, for a public
 * link or an archive; `seed` fixes its blind order. A live rendering is the owner's own view over
 * the run folders, to preview a publication or to present from the app: nothing is copied.
 */
type Target = { kind: 'snapshot'; seed: string } | { kind: 'live' }

/**
 * Display order of a publication. A blind one is shuffled, identically for the page and its
 * slides: each variant's place comes from a key derived from the seed, so a live rendering keeps
 * its letters across reloads and a refreshed link keeps the relative order of what it had.
 */
export function displayOrder(benchmark: Pick<BenchmarkDto, 'variants'>, options: Pick<BenchmarkShareOptions, 'blind'>, seed: string): string[] {
  const ids = benchmark.variants.map((variant) => variant.id)
  if (!options.blind) return ids
  const key = (id: string) => createHash('sha256').update(`${seed}:${id}`).digest('hex')
  return [...ids].sort((a, b) => key(a).localeCompare(key(b)))
}

/**
 * Shared benchmarks: a frozen page, its slideshow and a copy of the productions that work as
 * plain files. One composition feeds every way out (the public link, the archive and the owner's
 * live rendering), so a friend sees what the owner rehearsed.
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
    return this.runner.dto(this.runner.load(id, userId))
  }

  private async assess(benchmark: BenchmarkDto, limits: WalkLimits = SNAPSHOT_LIMITS): Promise<Map<string, RunAssessment>> {
    const result = new Map<string, RunAssessment>()
    for (const run of benchmark.runs) {
      if (UNSETTLED.has(run.status)) {
        result.set(run.id, { mode: 'none', reason: 'unfinished', entry: null, files: [], bytes: 0 })
        continue
      }
      result.set(run.id, await assessRunFolder(run.previewToken ? this.runner.previewRoot(run.previewToken) : null, limits))
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
      refreshedAt: row.refreshedAt,
      refreshable: row.options !== null,
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

  private async compose(benchmark: BenchmarkDto, options: BenchmarkShareOptions, target: Target): Promise<Composition> {
    const live = target.kind === 'live'
    const assessments = await this.assess(benchmark, live ? LIVE_LIMITS : SNAPSHOT_LIMITS)
    // The owner's own letters only need to hold across reloads, whatever options they try.
    const order = displayOrder(benchmark, options, live ? `live:${benchmark.id}` : target.seed)

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
      const excerpts = verdict.mode === 'files' ? await readExcerpts(root, verdict.files) : {}
      if (live) {
        // Served in place by the preview route, same origin: the page frames it like a copy.
        // Never the run's own token in a live document: see BenchmarkRunner.liveToken.
        const dir = `${BENCHMARK_PREVIEW_PREFIX}${encodeURIComponent(this.runner.liveToken(run.previewToken!))}`
        runs.push({ run: shared, mode: verdict.mode, reason: null, dir, entry: verdict.entry, files: verdict.files, excerpts })
        continue
      }
      const dir = `runs/${++folder}`
      bytes += verdict.bytes
      if (bytes > MAX_BENCHMARK_SHARE_BYTES) {
        throw new HttpError(413, 'benchmark_share_too_large', 'The productions are too large to share together (maximum {maxMb} MB).', {
          maxMb: MAX_BENCHMARK_SHARE_BYTES / 1024 / 1024,
        })
      }
      for (const file of verdict.files) copies.push({ source: join(root, file.path), target: `${dir}/${file.path}` })
      runs.push({ run: shared, mode: verdict.mode, reason: null, dir, entry: verdict.entry, files: verdict.files, excerpts })
    }
    const links: SharePage['links'] = live
      ? {
          page: benchmarkLiveUrl(benchmark.id, 'page', options),
          slides: options.includeSlides ? benchmarkLiveUrl(benchmark.id, 'slides', options) : null,
          // Like a copy, leaving the slides returns to the page; the window Present opened closes instead.
          exit: benchmarkLiveUrl(benchmark.id, 'page', options),
        }
      : { page: 'index.html', slides: options.includeSlides ? BENCHMARK_SLIDES_FILE : null, exit: 'index.html' }
    return {
      page: { benchmark, options, runs, order, sharedAt: Date.now(), live, links, comparisons: featuredComparisons(benchmark, options, order) },
      copies,
    }
  }

  /** The page, its slideshow and the copied productions, written into a folder that does not exist yet. */
  private async writeSnapshot(target: string, composition: Composition): Promise<void> {
    await mkdir(target, { recursive: true, mode: 0o700 })
    for (const copy of composition.copies) {
      // Regular files only, checked again at copy time: a link swapped in since the inventory
      // would otherwise publish whatever it points at.
      if (!(await lstat(copy.source).catch(() => null))?.isFile()) continue
      const destination = join(target, copy.target)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(copy.source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    }
    await writeFile(join(target, 'index.html'), renderBenchmarkShare(composition.page), { mode: 0o600, flag: 'wx' })
    if (composition.page.links.slides) {
      await writeFile(join(target, BENCHMARK_SLIDES_FILE), renderBenchmarkSlides(composition.page), { mode: 0o600, flag: 'wx' })
    }
  }

  /** Publishes a snapshot: later runs, ratings or cleanups never change what the link shows until it is refreshed. */
  async publish(benchmarkId: string, userId: string, options: BenchmarkShareOptions, expiresAt: number | null): Promise<BenchmarkShareDto> {
    if (!this.root()) throw badRequest('benchmark_share_unavailable', 'Public sharing is unavailable on this instance.')
    if (expiresAt !== null && expiresAt <= Date.now()) throw badRequest('export_expiry', 'Expiration must be in the future.')
    const benchmark = this.benchmark(benchmarkId, userId)
    const id = randomBytes(24).toString('base64url')
    const composition = await this.compose(benchmark, options, { kind: 'snapshot', seed: id })

    const target = join(this.directory, id)
    this.publishing.add(id)
    try {
      await this.writeSnapshot(target, composition)
      // The benchmark may have been deleted while files were copied.
      this.runner.load(benchmarkId, userId)
      const row = {
        id, benchmarkId, userId, title: options.title, createdAt: composition.page.sharedAt, expiresAt, revokedAt: null,
        // Kept so the link can be regenerated under the same address once the benchmark changed.
        options: JSON.stringify(options), refreshedAt: null,
      }
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
   * Regenerates a live link under the same address with the options it was published with: a
   * model added to the benchmark, new ratings, a rerun of a production. The new snapshot is
   * written beside the old one and swapped in, so a reader never gets a half-written page.
   */
  async refresh(benchmarkId: string, shareId: string, userId: string): Promise<BenchmarkShareDto> {
    if (!this.root()) throw badRequest('benchmark_share_unavailable', 'Public sharing is unavailable on this instance.')
    this.runner.load(benchmarkId, userId)
    const row = this.ctx.db
      .select()
      .from(benchmarkShares)
      .where(and(eq(benchmarkShares.id, shareId), eq(benchmarkShares.benchmarkId, benchmarkId), eq(benchmarkShares.userId, userId)))
      .get()
    if (!row) throw notFound('not_found', 'Not found.')
    if (row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= Date.now())) {
      throw new HttpError(409, 'benchmark_share_inactive', 'This link was revoked or has expired: publish a new one.')
    }
    if (row.options === null) {
      throw new HttpError(409, 'benchmark_share_not_refreshable', 'This link was published before links kept their options: publish a new one.')
    }
    const options = benchmarkShareOptionsSchema.parse(JSON.parse(row.options))
    const composition = await this.compose(this.benchmark(benchmarkId, userId), options, { kind: 'snapshot', seed: shareId })

    const target = join(this.directory, shareId)
    const staging = `.staging-${shareId}-${randomUUID()}`
    const trash = `.trash-${shareId}-${randomUUID()}`
    this.publishing.add(staging)
    this.publishing.add(trash)
    try {
      await this.writeSnapshot(join(this.directory, staging), composition)
      // Copying takes a while: a revocation or a deletion meanwhile must not be undone by the swap.
      const current = this.ctx.db.select({ revokedAt: benchmarkShares.revokedAt, expiresAt: benchmarkShares.expiresAt })
        .from(benchmarkShares).where(eq(benchmarkShares.id, shareId)).get()
      if (!current || current.revokedAt !== null || (current.expiresAt !== null && current.expiresAt <= Date.now())) {
        throw new HttpError(409, 'benchmark_share_inactive', 'This link was revoked or has expired: publish a new one.')
      }
      const existed = (await stat(target).catch(() => null)) !== null
      if (existed) await rename(target, join(this.directory, trash))
      try {
        await rename(join(this.directory, staging), target)
      } catch (error) {
        if (existed) await rename(join(this.directory, trash), target).catch(() => undefined)
        throw error
      }
      await rm(join(this.directory, trash), { recursive: true, force: true })
      // A revocation landing between the check and the swap removed the old folder, not this one.
      const after = this.ctx.db.select({ revokedAt: benchmarkShares.revokedAt }).from(benchmarkShares).where(eq(benchmarkShares.id, shareId)).get()
      if (!after || after.revokedAt !== null) {
        await rm(target, { recursive: true, force: true })
        throw new HttpError(409, 'benchmark_share_inactive', 'This link was revoked or has expired: publish a new one.')
      }
      const refreshedAt = composition.page.sharedAt
      this.ctx.db.update(benchmarkShares).set({ refreshedAt }).where(eq(benchmarkShares.id, shareId)).run()
      return this.shareDto({ ...row, refreshedAt })
    } finally {
      await rm(join(this.directory, staging), { recursive: true, force: true })
      this.publishing.delete(staging)
      this.publishing.delete(trash)
    }
  }

  /**
   * The same page as an archive to send or host anywhere: `index.html` and `slides.html` beside
   * the productions. The documents are written to scratch files because the archive streams from
   * disk; `dispose` removes them once the download ends.
   */
  async archive(benchmarkId: string, userId: string, options: BenchmarkShareOptions): Promise<{ filename: string; items: ArchiveItem[]; dispose: () => Promise<void> }> {
    const benchmark = this.benchmark(benchmarkId, userId)
    const { page, copies } = await this.compose(benchmark, options, { kind: 'snapshot', seed: randomUUID() })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // The `.page-` prefix is what the sweep spares while a download may still be reading it.
    const scratch = join(this.directory, `.page-${randomUUID()}`)
    const mtime = new Date(page.sharedAt)
    const documents: { name: string; absolute: string; html: string }[] = [{ name: 'index.html', absolute: `${scratch}.html`, html: renderBenchmarkShare(page) }]
    if (page.links.slides) documents.push({ name: BENCHMARK_SLIDES_FILE, absolute: `${scratch}-slides.html`, html: renderBenchmarkSlides(page) })
    for (const document of documents) await writeFile(document.absolute, document.html, { mode: 0o600, flag: 'wx' })
    const items: ArchiveItem[] = [
      ...documents.map((document) => ({ name: document.name, absolute: document.absolute, isDirectory: false, mtime })),
      ...copies.map((copy) => ({ name: copy.target, absolute: copy.source, isDirectory: false, mtime })),
    ]
    const name = options.title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').trim() || 'benchmark'
    return {
      filename: `${name}.zip`,
      items,
      dispose: async () => {
        for (const document of documents) await rm(document.absolute, { force: true })
      },
    }
  }

  /**
   * The owner's rendering of the page or the slideshow over the run folders: what a publication
   * would show, without copying anything. Also what presenting from the app opens.
   */
  async live(benchmarkId: string, userId: string, options: BenchmarkShareOptions, document: 'page' | 'slides'): Promise<string> {
    const { page } = await this.compose(this.benchmark(benchmarkId, userId), options, { kind: 'live' })
    return document === 'page' ? renderBenchmarkShare(page) : renderBenchmarkSlides(page)
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
  /** Links of a benchmark, read before its deletion: the cascade removes the rows, not their folders. */
  linksOf(benchmarkId: string): string[] {
    return this.ctx.db.select({ id: benchmarkShares.id }).from(benchmarkShares).where(eq(benchmarkShares.benchmarkId, benchmarkId)).all().map((row) => row.id)
  }

  async removeFolders(ids: string[]): Promise<void> {
    for (const id of ids) await rm(join(this.directory, id), { recursive: true, force: true })
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
      // Also spares the staging and trash folders of a refresh in progress.
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

/** Beginnings of a run's text files, read in place: a page opened from disk cannot fetch them. */
async function readExcerpts(root: string, files: RunFile[]): Promise<Record<string, string>> {
  const excerpts: Record<string, string> = {}
  const texts = files.filter((file) => deliverableKind(file.path) === 'text').slice(0, MAX_EXCERPTS_PER_RUN)
  for (const file of texts) excerpts[file.path] = await excerpt(join(root, file.path))
  return excerpts
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
