import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { and, asc, eq, or } from 'drizzle-orm'
import { librarySkills, type Db, type LibrarySkillRow } from '@sillage/db'
import type {
  CreateLibrarySkillBody,
  LibrarySkillDetailDto,
  LibrarySkillDto,
  LibrarySkillProblem,
  LibrarySkillScope,
  UpdateLibrarySkillBody,
} from '@sillage/protocol'
import { conflict, notFound } from '../http/errors.js'
import { compatNotes } from './compat.js'
import {
  newSkillMarkdown,
  parseSkillMarkdown,
  updateSkillMarkdown,
  type SkillMarkdown,
} from './frontmatter.js'
import { SkillLibraryLayout } from './layout.js'

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
    const { scope, projectId, name } = input
    this.assertFreeName(name, scope, projectId)
    const target = this.layout.skillDir(scope, projectId, name)
    this.assertFreeDirectory(target, name)

    this.layout.ensureScope(scope, projectId)
    const staging = this.stage()
    writeFileSync(join(staging, 'SKILL.md'), newSkillMarkdown(name, input.description, input.body))
    renameSync(staging, target)

    const now = Date.now()
    const row: LibrarySkillRow = {
      id: randomUUID(),
      scope,
      projectId,
      name,
      enabled: true,
      sourceId: null,
      sourcePath: null,
      sourceCommit: null,
      installedHash: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    }
    this.db.insert(librarySkills).values(row).run()
    this.onChange(projectId)
    return this.toDto(row, this.inspect(row))
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

  private writeAtomic(path: string, content: string): void {
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
          ? { sourceId: row.sourceId, path: row.sourcePath, commit: row.sourceCommit }
          : null,
      // Calculée seulement pour un skill installé : sans empreinte de référence, il n'y a
      // rien à comparer, et lire tous les fichiers à chaque liste serait pour rien.
      locallyModified:
        row.installedHash !== null && problem !== 'skill_missing'
          ? contentHash(inspection.dir, files) !== row.installedHash
          : false,
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
 */
export function listFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      if (files.length >= MAX_LISTED_FILES) return
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  walk('')
  return files.sort()
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
