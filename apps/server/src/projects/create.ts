import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { max } from 'drizzle-orm'
import { projects } from '@sillage/db'
import { createProjectBodySchema, type InstructionsMode, type MemoryMode } from '@sillage/protocol'
import { readUserSettings } from '../settings/user-settings.js'
import { repoInstructionFiles } from '../instructions/store.js'
import type { AppContext } from '../http/context.js'
import { badRequest, conflict } from '../http/errors.js'

export async function assertUsableWorkspace(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw badRequest('workspace_not_absolute', 'The workspace path must be absolute.')
  }

  const resolved = resolve(path)
  let info
  try {
    info = await stat(resolved)
  } catch {
    throw badRequest('workspace_missing', 'Directory {path} does not exist.', { path: resolved })
  }

  if (!info.isDirectory()) {
    throw badRequest('workspace_not_a_directory', '{path} is not a directory.', { path: resolved })
  }

  return resolved
}

/**
 * Le dossier que le clone va remplir.
 *
 * Symétrique de `assertUsableWorkspace` : là où un projet ordinaire exige un dossier qui
 * existe, un clone exige un emplacement libre. Un dossier existant mais vide est accepté,
 * parce que c'est ce que produit un `mkdir` fait d'avance par l'utilisateur.
 */
export async function assertFreeDestination(parentDir: string, directory: string): Promise<string> {
  if (!isAbsolute(parentDir)) {
    throw badRequest('workspace_not_absolute', 'The workspace path must be absolute.')
  }
  // Le nom de dossier vient d'une URL de dépôt : sans cette garde, `..` ferait écrire
  // le clone n'importe où sur le disque.
  if (directory.includes('/') || directory.includes('\\') || directory.startsWith('.')) {
    throw badRequest('clone_directory_invalid', 'The directory name must be a plain folder name.')
  }

  const parent = resolve(parentDir)
  const info = await stat(parent).catch(() => null)
  if (!info) {
    throw badRequest('workspace_missing', 'Directory {path} does not exist.', { path: parent })
  }
  if (!info.isDirectory()) {
    throw badRequest('workspace_not_a_directory', '{path} is not a directory.', { path: parent })
  }

  const destination = join(parent, directory)
  const existing = await readdir(destination).catch(() => null)
  if (existing && existing.length > 0) {
    throw conflict(
      'clone_destination_not_empty',
      'Directory {path} already exists and is not empty.',
      { path: destination },
    )
  }

  return destination
}

/**
 * En fin de liste : s'insérer au milieu déplacerait visuellement des projets que
 * l'utilisateur avait rangés lui-même.
 */
export const insertProject = async (
  ctx: AppContext,
  ownerId: string,
  fields: {
    name: string
    workspacePath: string
    visibility: 'private' | 'shared'
    color: string | null
    instructionsMode: InstructionsMode | undefined
    memoryMode?: MemoryMode
  },
) => {
  const [highest] = await ctx.db.select({ max: max(projects.position) }).from(projects)
  // Ce que le compte a choisi pour ses projets à venir, quand la création ne dit rien.
  const defaults = readUserSettings(ctx.db, ownerId).projectDefaults

  const row = {
    id: randomUUID(),
    ...fields,
    // Fixé dès la création : un mode résolu à chaque lancement basculerait le jour où
    // un agent crée un AGENTS.md. Faute de choix, le défaut du compte ; `auto` regarde
    // ce que le dossier porte déjà.
    instructionsMode:
      fields.instructionsMode ??
      (defaults.instructionsMode !== 'auto'
        ? defaults.instructionsMode
        : repoInstructionFiles(fields.workspacePath).length > 0
          ? 'repo'
          : 'sillage'),
    memoryMode: fields.memoryMode ?? defaults.memoryMode,
    ownerId,
    defaultConfig: null,
    turnCheckpoints: true,
    position: (highest?.max ?? 0) + 1,
    archivedAt: null,
    createdAt: Date.now(),
  }
  await ctx.db.insert(projects).values(row)
  return row
}

/** Partagé avec l'interface pour garder les mêmes validations et valeurs initiales. */
export async function createProject(ctx: AppContext, ownerId: string, input: unknown) {
  const body = createProjectBodySchema.parse(input)
  let workspacePath: string
  if ('workspacePath' in body) {
    workspacePath = await assertUsableWorkspace(body.workspacePath)
  } else {
    workspacePath = await assertFreeDestination(body.parentDir, body.directory)
    await mkdir(workspacePath, { recursive: true })
  }
  return insertProject(ctx, ownerId, {
    name: body.name,
    workspacePath,
    visibility: body.visibility,
    color: body.color,
    instructionsMode: body.instructionsMode,
    memoryMode: body.memoryMode,
  })
}
