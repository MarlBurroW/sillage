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
import { and, asc, eq, or } from 'drizzle-orm'
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

/**
 * La bibliothèque de skills : la base dit ce qui existe et où, le disque porte le
 * contenu.
 *
 * Toutes les opérations sur le disque sont synchrones, et ce n'est pas de la paresse.
 * Une écriture déplace des dossiers puis met la base à jour, et rien ne doit s'intercaler
 * entre les deux. En synchrone, deux requêtes concurrentes ne peuvent pas s'entrelacer,
 * sans verrou à tenir. Les fichiers sont petits, le coût est négligeable.
 *
 * Un CLI ne doit jamais voir un skill à moitié écrit : Codex surveille ces dossiers et
 * relit dans les secondes qui suivent. Toute écriture passe donc par la zone de transit,
 * puis par un `rename`, atomique sur un même système de fichiers.
 */

/** Plafond de l'inventaire d'un dossier, contre un skill qui embarquerait un dépôt entier. */
const MAX_LISTED_FILES = 2000

/** Où un skill entre dans la bibliothèque. `name` remplace celui du frontmatter. */
export interface SkillTarget {
  scope: LibrarySkillScope
  projectId: string | null
  name?: string
}

/** D'où vient un skill installé depuis une source, et dans quelle version. */
export interface SkillOrigin {
  sourceId: string
  path: string
  commit: string
  /** Empreinte du skill dans la source, avant tout renommage à l'installation. */
  hash: string
}

/**
 * Le catalogue des sources, vu de la bibliothèque : ce qu'il faut pour dire qu'une
 * mise à jour existe. Une interface plutôt que le service des sources lui-même, qui a
 * besoin de la bibliothèque pour installer.
 */
export interface SourceCatalogReader {
  /** Empreinte actuelle d'un skill dans sa source, null si le catalogue ne le connaît pas. */
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

  /**
   * `onChange` reçoit le projet touché, ou null pour la portée globale, qui concerne
   * toutes les conversations. C'est ce qui fait recharger les sessions ouvertes.
   */
  constructor(
    private readonly db: Db,
    root: string,
    private readonly onChange: (projectId: string | null) => void = () => {},
    private readonly catalog: SourceCatalogReader | null = null,
  ) {
    this.layout = new SkillLibraryLayout(root)
  }

  /** Les skills globaux, plus ceux du projet quand il est donné. */
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

  /** Les skills installés depuis une source, pour son catalogue. */
  installedFrom(sourceId: string): LibrarySkillRow[] {
    return this.db.select().from(librarySkills).where(eq(librarySkills.sourceId, sourceId)).all()
  }

  /** Voir `SourceCatalogReader` : la source a-t-elle changé depuis l'installation ? */
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

  /**
   * Fait entrer un skill dans la bibliothèque à partir de ses fichiers : création, import
   * d'une archive, reprise d'un skill de la machine, duplication.
   *
   * Le dossier est écrit entier dans la zone de transit, puis déplacé d'un geste : Codex
   * surveille la racine, et ne doit pas voir un `SKILL.md` sans ses fichiers annexes.
   * Quand `target.name` remplace le nom du frontmatter, celui-ci est réécrit : le nom du
   * dossier et celui du fichier doivent rester le même.
   */
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
      // Ce qui a été écrit, renommage compris : c'est la référence d'une modification locale.
      installedHash: origin ? contentHash(dir, listFiles(dir)) : null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    }
    this.db.insert(librarySkills).values(row).run()
    this.onChange(projectId)
    return this.toDto(row, this.inspect(row))
  }

  /**
   * Remplace le contenu d'un skill installé par la version de sa source. Le nom reste
   * celui de la bibliothèque : un skill renommé à l'installation le reste.
   *
   * Le dossier est remplacé d'un geste, comme à l'installation. Une modification locale
   * est écrasée : c'est à l'interface de l'annoncer avant.
   */
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

  /**
   * Ce que deviendrait le dossier d'un skill avec ces fichiers, écrit à part : de quoi
   * montrer le diff d'une mise à jour sans rien toucher. À effacer par l'appelant.
   */
  stageUpdate(row: LibrarySkillRow, files: Map<string, Uint8Array>): string {
    const { text, data } = readMain(files)
    return this.stageFiles(files, row.name, text, data)
  }

  /** Le dossier actuel d'un skill, pour le comparer à une version de sa source. */
  directoryOf(row: LibrarySkillRow): string {
    return this.existingDir(row)
  }

  /** Une zone de transit vide, à effacer par l'appelant. */
  scratch(): string {
    return this.stage()
  }

  /**
   * Écrit les fichiers dans la zone de transit. Quand le nom du skill diffère de celui
   * du frontmatter, celui-ci est réécrit : le nom du dossier et celui du fichier doivent
   * rester le même.
   */
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

  /** Une copie sous un autre nom, ou dans une autre portée. La provenance ne suit pas. */
  duplicate(row: LibrarySkillRow, target: SkillTarget, userId: string): LibrarySkillDto {
    return this.install(this.readAll(row), target, userId)
  }

  /** Copie un skill trouvé sur la machine. L'original reste en place, intact. */
  adopt(dir: string, target: SkillTarget, userId: string): LibrarySkillDto {
    return this.install(readDirectory(dir), target, userId)
  }

  exportArchive(row: LibrarySkillRow): Uint8Array {
    return writeSkillArchive(row.name, this.readAll(row))
  }

  /**
   * Un fichier annexe, en texte quand il s'édite. Binaire ou trop lourd pour l'éditeur,
   * il est décrit sans son contenu.
   */
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

  /** Supprime un fichier, puis les dossiers que son départ laisse vides. */
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

  /**
   * Contenu, puis emplacement : renommer, changer de portée et (dés)activer sont tous un
   * déplacement de dossier. Tout est vérifié avant la première écriture, pour qu'un refus
   * ne laisse pas un skill réécrit mais resté à son ancienne place.
   */
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
    // Sorti des racines d'un seul geste, puis effacé : un CLI qui relit entre les deux
    // ne trouve pas un dossier à moitié vidé.
    if (existsSync(dir)) {
      const trash = join(this.layout.stagingDir(), randomUUID())
      mkdirSync(this.layout.stagingDir(), { recursive: true })
      renameSync(dir, trash)
      rmSync(trash, { recursive: true, force: true })
    }
    this.db.delete(librarySkills).where(eq(librarySkills.id, row.id)).run()
    this.onChange(row.projectId)
  }

  /** Les dossiers d'un projet qu'on supprime, à appeler avant la cascade SQL. */
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

  /** Une écriture de fichier vaut modification du skill, pour la liste comme pour les sessions. */
  private touch(row: LibrarySkillRow): void {
    this.db.update(librarySkills).set({ updatedAt: Date.now() }).where(eq(librarySkills.id, row.id)).run()
    this.onChange(row.projectId)
  }

  private dirOf(row: Pick<LibrarySkillRow, 'id' | 'enabled' | 'scope' | 'projectId' | 'name'>): string {
    return row.enabled
      ? this.layout.skillDir(row.scope, row.projectId, row.name)
      : this.layout.disabledDir(row.id)
  }

  /**
   * Un nom ne vaut qu'une fois sur ce qu'une conversation voit, soit le global plus son
   * projet. Un skill global entre en collision avec tous les projets, un skill de projet
   * avec le global et son seul projet. Les skills désactivés comptent : les réactiver ne
   * doit pas créer de doublon.
   *
   * Côté Claude, deux homonymes vivraient sous deux préfixes, mais l'alias `/nom`
   * deviendrait ambigu. Côté Codex, les deux apparaîtraient.
   */
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

  /** Un dossier déposé à la main, que la base ne connaît pas, ne doit pas être écrasé. */
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
      // Calculée seulement pour un skill installé : sans empreinte de référence, il n'y a
      // rien à comparer, et lire tous les fichiers à chaque liste serait pour rien.
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

/**
 * Fichiers d'un skill, en chemins relatifs à séparateur `/`, triés. Les liens
 * symboliques sont ignorés : un skill ne doit rien faire lire hors de son dossier.
 * `.git` aussi : un dépôt dont la racine est un skill ne doit pas apporter son
 * historique dans la bibliothèque.
 */
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

/**
 * Le `SKILL.md` d'un jeu de fichiers, lu et vérifié : un skill qui entre dans la
 * bibliothèque doit au moins avoir une description, qui est ce que les CLI listent.
 */
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

/** Les fichiers d'un dossier de skill, liens symboliques exclus comme dans `listFiles`. */
export function readDirectory(dir: string): Map<string, Uint8Array> {
  return new Map(listFiles(dir).map((path) => [path, readFileSync(join(dir, path))]))
}

/** Le test de Git : un octet nul dans les premiers kilo-octets signe un binaire. */
function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8000).includes(0)
}

/**
 * Empreinte du contenu d'un skill : chemins et contenus, indépendante de l'ordre de
 * lecture et des dates de modification, que la copie depuis une source ne conserve pas.
 */
export function contentHash(dir: string, files: string[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    const path = join(dir, file)
    if (!lstatSync(path).isFile()) continue
    hash.update(`${file}\0${createHash('sha256').update(readFileSync(path)).digest('hex')}\n`)
  }
  return hash.digest('hex')
}
