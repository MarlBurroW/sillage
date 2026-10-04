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

/**
 * Sources de la bibliothèque de skills : des dépôts git, clonés en profondeur 1 dans le
 * cache, d'où l'on installe.
 *
 * Le clone est un miroir et rien d'autre : rafraîchir le remet sur la ref suivie, quoi
 * qu'on y ait laissé. Le catalogue (les dossiers qui portent un `SKILL.md`, avec
 * l'empreinte de chacun) se calcule une fois par commit et se garde à côté du clone,
 * parce qu'un dépôt comme anthropics/skills embarque des fichiers lourds à relire.
 */

const execFileAsync = promisify(execFile)

/** Un clone de profondeur 1 tient en secondes ; au-delà, le réseau ou le dépôt cloche. */
const GIT_TIMEOUT_MS = 120_000

/** Les skills se rangent à un ou deux niveaux d'un dépôt ; plus bas, c'est autre chose. */
const MAX_DEPTH = 4

export interface CatalogEntry {
  /** Dossier du skill relatif à la racine du dépôt, vide quand le dépôt est le skill. */
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
  /** Catalogues relus, par source. Null : la source n'a jamais été récupérée. */
  private readonly catalogs = new Map<string, Catalog | null>()
  /** Un rafraîchissement en cours par source : un second appel attend le premier. */
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

  /** Changer d'URL, de ref ou de dossier rend le clone et son catalogue caducs. */
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

  /** Les skills installés depuis cette source restent, leur provenance aussi. */
  remove(row: SkillSourceRow): void {
    this.forget(row.id)
    this.db.delete(skillSources).where(eq(skillSources.id, row.id)).run()
  }

  /**
   * Clone la source, ou la remet au dernier commit de sa ref, puis refait son catalogue.
   * `env` porte les identifiants git de qui déclenche : c'est ce qui ouvre un dépôt
   * privé d'équipe.
   */
  refresh(row: SkillSourceRow, env: NodeJS.ProcessEnv): Promise<SkillSourceRow> {
    const running = this.refreshing.get(row.id)
    if (running) return running
    const task = this.fetch(row, env).finally(() => this.refreshing.delete(row.id))
    this.refreshing.set(row.id, task)
    return task
  }

  /** Voir `SourceCatalogReader`. Une source désactivée ne signale pas de mise à jour. */
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

  /** Les fichiers d'un skill de la source, tels que le dernier rafraîchissement les a laissés. */
  files(row: SkillSourceRow, path: string): Map<string, Uint8Array> {
    this.entry(row, path)
    return readDirectory(join(this.cloneDir(row.id), path))
  }

  preview(row: SkillSourceRow, path: string): SourceSkillPreviewDto {
    const { commit } = this.entry(row, path)
    const dir = join(this.cloneDir(row.id), path)
    return { path, commit, main: readFileSync(join(dir, SKILL_MAIN_FILE), 'utf8'), files: listFiles(dir) }
  }

  /**
   * Ce qu'appliquer la mise à jour changerait, en diff unifié : le skill installé à
   * gauche, la source à droite, nom de la bibliothèque compris.
   *
   * Les deux versions sont posées côte à côte dans la zone de transit sous les noms
   * `installed` et `source`, que le diff retire ensuite de ses chemins : l'interface
   * affiche `SKILL.md`, pas un chemin absolu du serveur.
   */
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
        // Jamais récupérée, ou cache vidé : la source se rafraîchit pour revenir.
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

  /** Les identifiants préconfigurés contiennent un `:`, d'où un nom de dossier dérivé. */
  private cloneDir(id: string): string {
    return join(this.root, id.replace(/[^A-Za-z0-9_-]/g, '_'))
  }

  private catalogFile(id: string): string {
    return `${this.cloneDir(id)}.catalog.json`
  }
}

/**
 * L'URL à cloner et un nom lisible. `owner/repo` vaut pour GitHub : c'est la forme que
 * skills.sh et les README emploient. Un chemin local est refusé, comme pour le clone
 * d'un projet : la bibliothèque n'a pas à copier un dossier quelconque du serveur.
 */
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

/** `https://github.com/A/b.git` et `https://github.com/a/b` désignent le même dépôt. */
export function comparableUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '')
}

/**
 * Les dossiers qui portent un `SKILL.md`, sous le sous-dossier choisi. On ne descend pas
 * dans un skill trouvé, ni dans `.git`, `node_modules` ou un dossier caché.
 */
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
      // Sans terminal, un git qui veut demander un mot de passe doit échouer, pas attendre.
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

/** `git diff --no-index` sort en 1 quand il y a des différences : ce n'est pas un échec. */
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
