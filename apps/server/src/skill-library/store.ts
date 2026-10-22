import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { librarySkills, skillSources, type Db, type LibrarySkillRow } from '@sillage/db'
import {
  SKILL_MAIN_FILE,
  SKILL_TEXT_FILE_MAX_BYTES,
  skillDescriptionSchema,
  skillNameSchema,
  type CreateLibrarySkillBody,
  type LibrarySkillDetailDto,
  type LibrarySkillDto,
  type LibrarySkillFileDto,
  type LibrarySkillProblem,
  type LibrarySkillScope,
  type PaletteSkillDto,
  type UpdateLibrarySkillBody,
} from '@sillage/protocol'
import { badRequest, conflict, notFound } from '../http/errors.js'
import { writeSkillArchive } from './archive.js'
import { compatNotes } from './compat.js'
import {
  newSkillMarkdown,
  parseSkillMarkdown,
  updateSkillMarkdown,
  type SkillMarkdown,
} from './frontmatter.js'
import { SkillLibraryLayout } from './layout.js'
import { assertSkillFilePath } from './validate.js'

/** Skill library: the database records existence and location, disk holds contents. All disk operations are deliberately synchronous: writes move directories then update the database without allowing concurrent requests to interleave or requiring locks. Files are small, making the cost negligible. CLIs must never see half-written skills; Codex watches directories and reloads within seconds. All writes therefore stage first, then use same-filesystem atomic `rename`. */

/** Directory inventory limit to guard against skills containing whole repositories. */
const MAX_LISTED_FILES = 2000

/** Skill destination in the library; `name` overrides frontmatter. */
export interface SkillTarget {
  scope: LibrarySkillScope
  projectId: string | null
  name?: string
}

/** Source and version for source-installed skills. */
export interface SkillOrigin {
  sourceId: string
  path: string
  commit: string
  /** Source skill fingerprint before installation renaming. */
  hash: string
}

/** Source catalog interface seen by the library, sufficient to detect updates. Use an interface instead of the source service itself, which depends on the library for installation. */
export interface SourceCatalogReader {
  /** Current source fingerprint, or null when the catalog does not know the skill. */
  hashOf(sourceId: string, path: string): string | null
}

interface Inspection {
  dir: string
  markdown: SkillMarkdown | null
  files: string[]
  problem: LibrarySkillProblem | null
}

export class SkillLibrary {
  readonly layout: SkillLibraryLayout

  /** `onChange` receives the affected project or null for global changes affecting every conversation. This triggers reloads in open sessions. */
  constructor(
    private readonly db: Db,
    root: string,
    private readonly onChange: (projectId: string | null) => void = () => {},
    private readonly catalog: SourceCatalogReader | null = null,
  ) {
    this.layout = new SkillLibraryLayout(root)
  }

  /** Global skills plus project skills when a project is supplied. */
  list(projectId: string | null): LibrarySkillDto[] {
    const scope = projectId
      ? or(eq(librarySkills.scope, 'global'), eq(librarySkills.projectId, projectId))
      : eq(librarySkills.scope, 'global')
    return this.db
      .select()
      .from(librarySkills)
      .where(scope)
      .orderBy(asc(librarySkills.name))
      .all()
      .map((row) => this.toDto(row, this.inspect(row)))
  }

  /** Global skills and skills from these projects, for the palette. Read only `SKILL.md` descriptions: `list` also fingerprints installed skills by reading all files, information the palette never displays. */
  summaries(projectIds: readonly string[]): PaletteSkillDto[] {
    const scope = projectIds.length
      ? or(eq(librarySkills.scope, 'global'), inArray(librarySkills.projectId, [...projectIds]))
      : eq(librarySkills.scope, 'global')
    return this.db
      .select()
      .from(librarySkills)
      .where(scope)
      .orderBy(asc(librarySkills.name))
      .all()
      .map((row) => {
        let description = ''
        try {
          const data = parseSkillMarkdown(readFileSync(join(this.dirOf(row), SKILL_MAIN_FILE), 'utf8')).data
          if (typeof data.description === 'string') description = data.description
        } catch {
          // Unreadable skills remain discoverable by name; their page explains the issue.
        }
        return { id: row.id, projectId: row.projectId, name: row.name, description, enabled: row.enabled }
      })
  }

  /** Source-installed skills for the source catalog. */
  installedFrom(sourceId: string): LibrarySkillRow[] {
    return this.db.select().from(librarySkills).where(eq(librarySkills.sourceId, sourceId)).all()
  }

  /** See `SourceCatalogReader`: has the source changed since installation? */
  updateAvailable(row: LibrarySkillRow): boolean {
    if (!this.catalog || row.sourceId === null || row.sourcePath === null || row.sourceHash === null) return false
    const current = this.catalog.hashOf(row.sourceId, row.sourcePath)
    return current !== null && current !== row.sourceHash
  }

  row(id: string): LibrarySkillRow {
    const row = this.db.select().from(librarySkills).where(eq(librarySkills.id, id)).get()
    if (!row) throw notFound('skill_not_found', 'Unknown skill.')
    return row
  }

  detail(row: LibrarySkillRow): LibrarySkillDetailDto {
    const inspection = this.inspect(row)
    return {
      ...this.toDto(row, inspection),
      body: inspection.markdown?.body ?? '',
      frontmatter: inspection.markdown?.data ?? {},
      files: inspection.files,
    }
  }

  create(input: CreateLibrarySkillBody, userId: string): LibrarySkillDto {
    const markdown = newSkillMarkdown(input.name, input.description, input.body)
    return this.install(new Map([[SKILL_MAIN_FILE, Buffer.from(markdown)]]), input, userId)
  }

  /** Adds skills from files: creation, archive import, local adoption and duplication. Write the complete directory in staging then move it atomically: Codex watches the root and must not see `SKILL.md` without supporting files. When `target.name` overrides frontmatter, rewrite it so directory and file names agree. */
  install(
    files: Map<string, Uint8Array>,
    target: SkillTarget,
    userId: string,
    origin: SkillOrigin | null = null,
  ): LibrarySkillDto {
    const { text, data } = readMain(files)
    const name = target.name ?? data.name
    if (typeof name !== 'string' || !skillNameSchema.safeParse(name).success) {
      throw badRequest('skill_name_invalid', 'Invalid skill name: {name}.', { name: String(name ?? '') })
    }

    const { scope, projectId } = target
    this.assertFreeName(name, scope, projectId)
    const dir = this.layout.skillDir(scope, projectId, name)
    this.assertFreeDirectory(dir, name)

    const staging = this.stageFiles(files, name, text, data)
    this.layout.ensureScope(scope, projectId)
    renameSync(staging, dir)

    const now = Date.now()
    const row: LibrarySkillRow = {
      id: randomUUID(),
      scope,
      projectId,
      name,
      enabled: true,
      sourceId: origin?.sourceId ?? null,
      sourcePath: origin?.path ?? null,
      sourceCommit: origin?.commit ?? null,
      sourceHash: origin?.hash ?? null,
      // Written contents including renaming: the baseline for local modification checks.
      installedHash: origin ? contentHash(dir, listFiles(dir)) : null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    }
    this.db.insert(librarySkills).values(row).run()
    this.onChange(projectId)
    return this.toDto(row, this.inspect(row))
  }

  /** Replaces installed skill contents with the source version while retaining library names, including installation-time renames. Replace directories atomically as during installation. Local modifications are overwritten; the interface must disclose this beforehand. */
  applyUpdate(row: LibrarySkillRow, files: Map<string, Uint8Array>, origin: SkillOrigin): LibrarySkillDto {
    const dir = this.existingDir(row)
    const { text, data } = readMain(files)
    const staging = this.stageFiles(files, row.name, text, data)
    const trash = join(this.layout.stagingDir(), randomUUID())
    renameSync(dir, trash)
    renameSync(staging, dir)
    rmSync(trash, { recursive: true, force: true })

    const next: LibrarySkillRow = {
      ...row,
      sourceId: origin.sourceId,
      sourcePath: origin.path,
      sourceCommit: origin.commit,
      sourceHash: origin.hash,
      installedHash: contentHash(dir, listFiles(dir)),
      updatedAt: Date.now(),
    }
    this.db.update(librarySkills).set(next).where(eq(librarySkills.id, row.id)).run()
    this.onChange(row.projectId)
    return this.toDto(next, this.inspect(next))
  }

  /** Stages the skill directory these files would produce to show update diffs without changing anything. Callers must delete it. */
  stageUpdate(row: LibrarySkillRow, files: Map<string, Uint8Array>): string {
    const { text, data } = readMain(files)
    return this.stageFiles(files, row.name, text, data)
  }

  /** Current skill directory for comparison with a source version. */
  directoryOf(row: LibrarySkillRow): string {
    return this.existingDir(row)
  }

  /** Empty staging area, to be deleted by the caller. */
  scratch(): string {
    return this.stage()
  }

  /** Writes staged files. If the skill name differs from frontmatter, rewrite it to keep the directory and file names consistent. */
  private stageFiles(
    files: Map<string, Uint8Array>,
    name: string,
    text: string,
    data: Record<string, unknown>,
  ): string {
    const staging = this.stage()
    for (const [path, content] of files) {
      const destination = join(staging, assertSkillFilePath(path, { allowMain: true }))
      mkdirSync(dirname(destination), { recursive: true })
      const renamed = path === SKILL_MAIN_FILE && name !== data.name
      writeFileSync(destination, renamed ? updateSkillMarkdown(text, { name }) : content)
    }
    return staging
  }

  /** Copy under another name or scope; provenance is not inherited. */
  duplicate(row: LibrarySkillRow, target: SkillTarget, userId: string): LibrarySkillDto {
    return this.install(this.readAll(row), target, userId)
  }

  /** Copies a skill found on the machine, leaving the original intact. */
  adopt(dir: string, target: SkillTarget, userId: string): LibrarySkillDto {
    return this.install(readDirectory(dir), target, userId)
  }

  exportArchive(row: LibrarySkillRow): Uint8Array {
    return writeSkillArchive(row.name, this.readAll(row))
  }

  /** Supporting file as text when editable; binary or oversized files are described without content. */
  readFile(row: LibrarySkillRow, path: string): LibrarySkillFileDto {
    const file = join(this.existingDir(row), assertSkillFilePath(path, { allowMain: true }))
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      throw notFound('skill_file_not_found', 'Unknown file in this skill: {path}.', { path })
    }
    const size = statSync(file).size
    if (size > SKILL_TEXT_FILE_MAX_BYTES) return { path, size, content: null }
    const buffer = readFileSync(file)
    return { path, size, content: isText(buffer) ? buffer.toString('utf8') : null }
  }

  writeFile(row: LibrarySkillRow, path: string, content: string | Uint8Array): void {
    const file = join(this.existingDir(row), assertSkillFilePath(path))
    mkdirSync(dirname(file), { recursive: true })
    this.writeAtomic(file, content)
    this.touch(row)
  }

  /** Deletes a file, then directories left empty by its removal. */
  deleteFile(row: LibrarySkillRow, path: string): void {
    const dir = this.existingDir(row)
    const file = join(dir, assertSkillFilePath(path))
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      throw notFound('skill_file_not_found', 'Unknown file in this skill: {path}.', { path })
    }
    rmSync(file)
    for (let parent = dirname(file); parent !== dir && readdirSync(parent).length === 0; parent = dirname(parent)) {
      rmdirSync(parent)
    }
    this.touch(row)
  }

  /** Content then location: renaming, scope changes and enabling/disabling all move directories. Validate everything before the first write so rejections cannot leave rewritten skills in old locations. */
  update(row: LibrarySkillRow, patch: UpdateLibrarySkillBody): LibrarySkillDto {
    const next: LibrarySkillRow = {
      ...row,
      name: patch.name ?? row.name,
      enabled: patch.enabled ?? row.enabled,
      ...(patch.scope !== undefined ? { scope: patch.scope, projectId: patch.projectId ?? null } : {}),
      updatedAt: Date.now(),
    }
    const from = this.dirOf(row)
    const to = this.dirOf(next)
    if (!existsSync(from)) {
      throw conflict('skill_missing', 'The folder of this skill is missing from the library.')
    }
    const relocated = next.name !== row.name || next.scope !== row.scope || next.projectId !== row.projectId
    if (relocated) this.assertFreeName(next.name, next.scope, next.projectId, row.id)
    if (to !== from) this.assertFreeDirectory(to, next.name)

    if (patch.name !== undefined || patch.description !== undefined || patch.body !== undefined) {
      const path = join(from, 'SKILL.md')
      let text: string
      try {
        text = updateSkillMarkdown(readFileSync(path, 'utf8'), patch)
      } catch {
        throw conflict('skill_unreadable', 'The SKILL.md of this skill cannot be read.')
      }
      this.writeAtomic(path, text)
    }

    if (to !== from) {
      if (next.enabled) this.layout.ensureScope(next.scope, next.projectId)
      else mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    }

    this.db.update(librarySkills).set(next).where(eq(librarySkills.id, row.id)).run()
    this.onChange(row.projectId)
    if (next.projectId !== row.projectId) this.onChange(next.projectId)
    return this.toDto(next, this.inspect(next))
  }

  remove(row: LibrarySkillRow): void {
    const dir = this.dirOf(row)
    // Move outside roots atomically before deleting so CLIs reloading between steps
    // never encounter partially emptied directories.
    if (existsSync(dir)) {
      const trash = join(this.layout.stagingDir(), randomUUID())
      mkdirSync(this.layout.stagingDir(), { recursive: true })
      renameSync(dir, trash)
      rmSync(trash, { recursive: true, force: true })
    }
    this.db.delete(librarySkills).where(eq(librarySkills.id, row.id)).run()
    this.onChange(row.projectId)
  }

  /** Project directories to delete before SQL cascades. */
  removeProject(projectId: string): void {
    const disabled = this.db
      .select({ id: librarySkills.id })
      .from(librarySkills)
      .where(and(eq(librarySkills.projectId, projectId), eq(librarySkills.enabled, false)))
      .all()
    for (const row of disabled) rmSync(this.layout.disabledDir(row.id), { recursive: true, force: true })
    this.layout.removeProject(projectId)
  }

  private existingDir(row: LibrarySkillRow): string {
    const dir = this.dirOf(row)
    if (!existsSync(dir)) {
      throw conflict('skill_missing', 'The folder of this skill is missing from the library.')
    }
    return dir
  }

  private readAll(row: LibrarySkillRow): Map<string, Uint8Array> {
    return readDirectory(this.existingDir(row))
  }

  /** File writes count as skill modifications for lists and sessions. */
  private touch(row: LibrarySkillRow): void {
    this.db.update(librarySkills).set({ updatedAt: Date.now() }).where(eq(librarySkills.id, row.id)).run()
    this.onChange(row.projectId)
  }

  private dirOf(row: Pick<LibrarySkillRow, 'id' | 'enabled' | 'scope' | 'projectId' | 'name'>): string {
    return row.enabled
      ? this.layout.skillDir(row.scope, row.projectId, row.name)
      : this.layout.disabledDir(row.id)
  }

  /** Names must be unique across what a conversation sees: global plus project. Global skills collide with every project; project skills with global and their own project only. Disabled skills also count so reenabling cannot create duplicates. Claude would expose duplicates under different prefixes but make `/nom` ambiguous; Codex would list both. */
  private assertFreeName(
    name: string,
    scope: LibrarySkillScope,
    projectId: string | null,
    exceptId?: string,
  ): void {
    const visible =
      scope === 'global'
        ? eq(librarySkills.name, name)
        : and(
            eq(librarySkills.name, name),
            or(eq(librarySkills.scope, 'global'), eq(librarySkills.projectId, projectId ?? '')),
          )
    const clash = this.db
      .select({ id: librarySkills.id })
      .from(librarySkills)
      .where(visible)
      .all()
      .find((row) => row.id !== exceptId)
    if (clash) {
      throw conflict('skill_name_taken', 'A skill named {name} already exists where it would be visible.', {
        name,
      })
    }
  }

  /** Never overwrite manually added directories unknown to the database. */
  private assertFreeDirectory(dir: string, name: string): void {
    if (existsSync(dir)) {
      throw conflict('skill_directory_exists', 'A folder named {name} already exists in the library.', {
        name,
      })
    }
  }

  private stage(): string {
    const dir = join(this.layout.stagingDir(), randomUUID())
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private writeAtomic(path: string, content: string | Uint8Array): void {
    const staging = this.stage()
    const temporary = join(staging, 'file')
    writeFileSync(temporary, content)
    renameSync(temporary, path)
    rmSync(staging, { recursive: true, force: true })
  }

  private inspect(row: LibrarySkillRow): Inspection {
    const dir = this.dirOf(row)
    if (!existsSync(dir)) return { dir, markdown: null, files: [], problem: 'skill_missing' }

    const files = listFiles(dir)
    let markdown: SkillMarkdown | null = null
    try {
      markdown = parseSkillMarkdown(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
    } catch {
      return { dir, markdown: null, files, problem: 'skill_unreadable' }
    }
    const problem = markdown.data.name === row.name ? null : 'skill_name_mismatch'
    return { dir, markdown, files, problem }
  }

  private sourceName(sourceId: string | null): string | null {
    if (sourceId === null) return null
    return this.db.select({ name: skillSources.name }).from(skillSources).where(eq(skillSources.id, sourceId)).get()?.name ?? null
  }

  private toDto(row: LibrarySkillRow, inspection: Inspection): LibrarySkillDto {
    const { markdown, files, problem } = inspection
    const description = markdown?.data.description
    return {
      id: row.id,
      scope: row.scope,
      projectId: row.projectId,
      name: row.name,
      description: typeof description === 'string' ? description : '',
      enabled: row.enabled,
      origin:
        row.sourcePath !== null && row.sourceCommit !== null
          ? {
              sourceId: row.sourceId,
              sourceName: this.sourceName(row.sourceId),
              path: row.sourcePath,
              commit: row.sourceCommit,
            }
          : null,
      // Calculate only for installed skills: without baseline fingerprints there is
      // nothing to compare, and reading every file for every list would be wasted work.
      locallyModified:
        row.installedHash !== null && problem !== 'skill_missing'
          ? contentHash(inspection.dir, files) !== row.installedHash
          : false,
      updateAvailable: this.updateAvailable(row),
      compat: markdown ? compatNotes(markdown.data, markdown.body, files) : [],
      problem,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}

/** Sorted skill file paths with `/` separators. Ignore symlinks to prevent reading outside skill directories, and `.git` so skills at repository roots do not import repository history into the library. */
export function listFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      if (files.length >= MAX_LISTED_FILES) return
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name !== '.git') walk(path)
      }
      else if (entry.isFile()) files.push(path)
    }
  }
  walk('')
  return files.sort()
}

/** Reads and validates `SKILL.md` from a file set: library skills must at least have descriptions, which CLIs display in their lists. */
function readMain(files: Map<string, Uint8Array>): { text: string; data: Record<string, unknown> } {
  const main = files.get(SKILL_MAIN_FILE)
  if (!main) throw badRequest('skill_main_missing', 'The skill has no SKILL.md.')
  const text = Buffer.from(main).toString('utf8')
  let data: Record<string, unknown>
  try {
    data = parseSkillMarkdown(text).data
  } catch {
    throw badRequest('skill_main_unreadable', 'The SKILL.md of this skill cannot be read.')
  }
  if (!skillDescriptionSchema.safeParse(data.description).success) {
    throw badRequest('skill_description_missing', 'The SKILL.md of this skill has no description.')
  }
  return { text, data }
}

/** Skill-directory files, excluding symlinks as in `listFiles`. */
export function readDirectory(dir: string): Map<string, Uint8Array> {
  return new Map(listFiles(dir).map((path) => [path, readFileSync(join(dir, path))]))
}

/** Git's binary check: null bytes in the first few kilobytes identify binary files. */
function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8000).includes(0)
}

/** Skill content fingerprint over paths and contents, independent of read order and modification times, which source copies do not preserve. */
export function contentHash(dir: string, files: string[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    const path = join(dir, file)
    if (!lstatSync(path).isFile()) continue
    hash.update(`${file}\0${createHash('sha256').update(readFileSync(path)).digest('hex')}\n`)
  }
  return hash.digest('hex')
}
