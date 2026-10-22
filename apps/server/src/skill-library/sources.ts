import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { skillSources, type Db, type LibrarySkillRow, type SkillSourceRow } from '@sillage/db'
import {
  SKILL_MAIN_FILE,
  parseRemoteUrl,
  skillNameSchema,
  type CreateSkillSourceBody,
  type SkillSourceDto,
  type SourceSkillPreviewDto,
  type UpdateSkillSourceBody,
} from '@sillage/protocol'
import { badRequest, conflict, notFound } from '../http/errors.js'
import { compatNotes } from './compat.js'
import { parseSkillMarkdown } from './frontmatter.js'
import { contentHash, listFiles, readDirectory, type SkillLibrary, type SourceCatalogReader } from './store.js'

/** Skill library sources are git repositories shallow-cloned into the installation cache. Clones are mirrors: refreshing resets them to the tracked ref regardless of local leftovers. Catalogs of `SKILL.md` directories and fingerprints are computed once per commit and stored beside clones because repositories such as anthropics/skills contain expensive large files. */

const execFileAsync = promisify(execFile)

/** Depth-1 clones take seconds; longer durations indicate network or repository trouble. */
const GIT_TIMEOUT_MS = 120_000

/** Skills normally live one or two levels into repositories; deeper entries are something else. */
const MAX_DEPTH = 4

export interface CatalogEntry {
  /** Skill directory relative to repository root; empty when the repository itself is the skill. */
  path: string
  name: string
  description: string
  problem: 'skill_unreadable' | 'skill_name_invalid' | null
  scripts: boolean
  hash: string
}

interface Catalog {
  commit: string
  entries: CatalogEntry[]
}

class GitFailure extends Error {}

export class SkillSources implements SourceCatalogReader {
  /** Loaded catalogs per source; null means never fetched. */
  private readonly catalogs = new Map<string, Catalog | null>()
  /** One refresh per source at a time: concurrent calls await the first. */
  private readonly refreshing = new Map<string, Promise<SkillSourceRow>>()

  constructor(
    private readonly db: Db,
    private readonly root: string,
  ) {}

  list(): SkillSourceRow[] {
    return this.db.select().from(skillSources).orderBy(asc(skillSources.name)).all()
  }

  row(id: string): SkillSourceRow {
    const row = this.db.select().from(skillSources).where(eq(skillSources.id, id)).get()
    if (!row) throw notFound('skill_source_not_found', 'Unknown skill source.')
    return row
  }

  toDto(row: SkillSourceRow): SkillSourceDto {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      ref: row.ref,
      subpath: row.subpath,
      builtin: row.builtin,
      enabled: row.enabled,
      lastCommit: row.lastCommit,
      lastFetchedAt: row.lastFetchedAt,
      lastError: row.lastError,
      skillCount: this.catalog(row.id)?.entries.length ?? null,
    }
  }

  create(input: CreateSkillSourceBody): SkillSourceRow {
    const remote = normalizeSourceUrl(input.url)
    this.assertFreeUrl(remote.url)
    const now = Date.now()
    const row: SkillSourceRow = {
      id: randomUUID(),
      name: input.name ?? remote.name,
      url: remote.url,
      ref: input.ref,
      subpath: input.subpath,
      builtin: false,
      enabled: true,
      lastCommit: null,
      lastFetchedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    this.db.insert(skillSources).values(row).run()
    return row
  }

  /** Changing URL, ref, or directory invalidates clone and catalog. */
  update(row: SkillSourceRow, patch: UpdateSkillSourceBody): SkillSourceRow {
    const url = patch.url === undefined ? row.url : normalizeSourceUrl(patch.url).url
    if (url !== row.url) this.assertFreeUrl(url)
    const next: SkillSourceRow = {
      ...row,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      url,
      ref: patch.ref === undefined ? row.ref : patch.ref,
      subpath: patch.subpath === undefined ? row.subpath : patch.subpath,
      updatedAt: Date.now(),
    }
    if (next.url !== row.url || next.ref !== row.ref || next.subpath !== row.subpath) {
      this.forget(row.id)
      Object.assign(next, { lastCommit: null, lastFetchedAt: null, lastError: null })
    }
    this.db.update(skillSources).set(next).where(eq(skillSources.id, row.id)).run()
    return next
  }

  /** Installed skills and their provenance remain when sources are removed. */
  remove(row: SkillSourceRow): void {
    this.forget(row.id)
    this.db.delete(skillSources).where(eq(skillSources.id, row.id)).run()
  }

  /** Clones sources or resets them to the latest tracked-ref commit, then rebuilds catalogs. `env` supplies the requester's git credentials for private team repositories. */
  refresh(row: SkillSourceRow, env: NodeJS.ProcessEnv): Promise<SkillSourceRow> {
    const running = this.refreshing.get(row.id)
    if (running) return running
    const task = this.fetch(row, env).finally(() => this.refreshing.delete(row.id))
    this.refreshing.set(row.id, task)
    return task
  }

  /** See `SourceCatalogReader`. Disabled sources do not report updates. */
  hashOf(sourceId: string, path: string): string | null {
    const source = this.db.select({ enabled: skillSources.enabled }).from(skillSources).where(eq(skillSources.id, sourceId)).get()
    if (!source?.enabled) return null
    return this.catalog(sourceId)?.entries.find((entry) => entry.path === path)?.hash ?? null
  }

  entries(row: SkillSourceRow): CatalogEntry[] {
    return this.catalog(row.id)?.entries ?? []
  }

  entry(row: SkillSourceRow, path: string): CatalogEntry & { commit: string } {
    const catalog = this.catalog(row.id)
    const entry = catalog?.entries.find((candidate) => candidate.path === path)
    if (!catalog || !entry) {
      throw notFound('source_skill_not_found', 'No skill at {path} in this source.', { path: path || '/' })
    }
    return { ...entry, commit: catalog.commit }
  }

  /** Source skill files as left by the latest refresh. */
  files(row: SkillSourceRow, path: string): Map<string, Uint8Array> {
    this.entry(row, path)
    return readDirectory(join(this.cloneDir(row.id), path))
  }

  preview(row: SkillSourceRow, path: string): SourceSkillPreviewDto {
    const { commit } = this.entry(row, path)
    const dir = join(this.cloneDir(row.id), path)
    return { path, commit, main: readFileSync(join(dir, SKILL_MAIN_FILE), 'utf8'), files: listFiles(dir) }
  }

  /** Unified update diff: installed skill on the left, source on the right, including the library name. Stage both versions as `installed` and `source`, then strip those prefixes from paths so the interface shows `SKILL.md` rather than absolute server paths. */
  async updatePatch(library: SkillLibrary, row: LibrarySkillRow, files: Map<string, Uint8Array>): Promise<string> {
    const scratch = library.scratch()
    try {
      renameSync(library.stageUpdate(row, files), join(scratch, 'source'))
      cpSync(library.directoryOf(row), join(scratch, 'installed'), { recursive: true })
      const patch = await diffNoIndex(scratch, 'installed', 'source')
      return patch
        .replaceAll(' a/installed/', ' a/')
        .replaceAll(' b/source/', ' b/')
        .replaceAll('--- a/installed/', '--- a/')
        .replaceAll('+++ b/source/', '+++ b/')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  private async fetch(row: SkillSourceRow, env: NodeJS.ProcessEnv): Promise<SkillSourceRow> {
    const dir = this.cloneDir(row.id)
    try {
      if (existsSync(join(dir, '.git'))) {
        await git(['fetch', '--depth', '1', 'origin', row.ref ?? 'HEAD'], { cwd: dir, env })
        await git(['reset', '--hard', 'FETCH_HEAD'], { cwd: dir })
        await git(['clean', '-fdx'], { cwd: dir })
      } else {
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(this.root, { recursive: true })
        const branch = row.ref ? ['--branch', row.ref] : []
        await git(['clone', '--depth', '1', '--single-branch', ...branch, '--', row.url, dir], { env })
      }
      const commit = await git(['rev-parse', 'HEAD'], { cwd: dir })
      const catalog: Catalog = { commit, entries: scanCatalog(dir, row.subpath) }
      writeFileSync(this.catalogFile(row.id), JSON.stringify(catalog))
      this.catalogs.set(row.id, catalog)

      const next = { ...row, lastCommit: commit, lastFetchedAt: Date.now(), lastError: null, updatedAt: Date.now() }
      this.db.update(skillSources).set(next).where(eq(skillSources.id, row.id)).run()
      return next
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.db
        .update(skillSources)
        .set({ lastError: message, updatedAt: Date.now() })
        .where(eq(skillSources.id, row.id))
        .run()
      throw badRequest('skill_source_fetch_failed', 'Fetching {name} failed: {message}', { name: row.name, message })
    }
  }

  private catalog(id: string): Catalog | null {
    if (!this.catalogs.has(id)) {
      let catalog: Catalog | null = null
      try {
        catalog = JSON.parse(readFileSync(this.catalogFile(id), 'utf8')) as Catalog
      } catch {
        // Never fetched or cache cleared: refresh the source to restore it.
      }
      this.catalogs.set(id, catalog)
    }
    return this.catalogs.get(id) ?? null
  }

  private forget(id: string): void {
    rmSync(this.cloneDir(id), { recursive: true, force: true })
    rmSync(this.catalogFile(id), { force: true })
    this.catalogs.delete(id)
  }

  private assertFreeUrl(url: string): void {
    const key = comparableUrl(url)
    if (this.list().some((source) => comparableUrl(source.url) === key)) {
      throw conflict('skill_source_exists', 'A source already points to {url}.', { url })
    }
  }

  /** Preconfigured IDs contain `:`, so derive directory names. */
  private cloneDir(id: string): string {
    return join(this.root, id.replace(/[^A-Za-z0-9_-]/g, '_'))
  }

  private catalogFile(id: string): string {
    return `${this.cloneDir(id)}.catalog.json`
  }
}

/** Clone URL and readable name. `owner/repo` means GitHub, matching skills.sh and READMEs. Reject local paths as for project cloning: the library must not copy arbitrary server directories. */
export function normalizeSourceUrl(input: string): { url: string; name: string } {
  const trimmed = input.trim()
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    const name = trimmed.replace(/\.git$/, '')
    return { url: `https://github.com/${name}.git`, name }
  }
  const remote = parseRemoteUrl(trimmed)
  if (!remote) {
    throw badRequest('skill_source_url_invalid', 'Expected a repository URL, or owner/repo for GitHub.')
  }
  const path = remote.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').replace(/^[^:]+:/, '')
  const segments = path.replace(/\.git$/, '').split('/').filter(Boolean)
  return { url: remote.url, name: segments.slice(-2).join('/') || remote.repo }
}

/** `https://github.com/A/b.git` and `https://github.com/a/b` identify the same repository. */
export function comparableUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '')
}

/** Directories containing `SKILL.md` below the chosen subdirectory. Never descend into discovered skills, `.git`, `node_modules` or hidden directories. */
function scanCatalog(repo: string, subpath: string | null): CatalogEntry[] {
  const base = subpath ? join(repo, subpath) : repo
  if (!existsSync(base)) throw new Error(`The folder ${subpath} does not exist in the repository.`)

  const entries: CatalogEntry[] = []
  const walk = (dir: string, depth: number): void => {
    if (existsSync(join(dir, SKILL_MAIN_FILE))) {
      entries.push(describe(repo, dir))
      return
    }
    if (depth >= MAX_DEPTH) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(base, 0)
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function describe(repo: string, dir: string): CatalogEntry {
  const path = relative(repo, dir).split(sep).join('/')
  const files = listFiles(dir)
  const hash = contentHash(dir, files)
  try {
    const { data, body } = parseSkillMarkdown(readFileSync(join(dir, SKILL_MAIN_FILE), 'utf8'))
    const name = typeof data.name === 'string' ? data.name : basename(dir)
    return {
      path,
      name,
      description: typeof data.description === 'string' ? data.description : '',
      problem: skillNameSchema.safeParse(name).success ? null : 'skill_name_invalid',
      scripts: compatNotes(data, body, files).some((note) => note.code === 'runs_scripts'),
      hash,
    }
  } catch {
    return { path, name: basename(dir), description: '', problem: 'skill_unreadable', scripts: false, hash }
  }
}

async function git(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: options.cwd,
      // Without a terminal, git password prompts must fail rather than wait.
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim()
    throw new GitFailure(stderr ? stderr.split('\n').slice(-3).join(' ') : err instanceof Error ? err.message : String(err))
  }
}

/** `git diff --no-index` exits 1 for differences; this is not failure. */
async function diffNoIndex(cwd: string, left: string, right: string): Promise<string> {
  try {
    await execFileAsync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-renames', '--', left, right], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    })
    return ''
  } catch (err) {
    const { code, stdout } = err as { code?: number; stdout?: string }
    if (code === 1 && typeof stdout === 'string') return stdout
    throw err
  }
}
