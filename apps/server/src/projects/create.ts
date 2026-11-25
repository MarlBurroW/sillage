import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { max } from 'drizzle-orm'
import { projectFolders, projects, writeTransaction } from '@sillage/db'
import { createProjectBodySchema, type InstructionsMode, type MemoryMode } from '@sillage/protocol'
import { readUserSettings } from '../settings/user-settings.js'
import { repoInstructionFiles } from '../instructions/store.js'
import type { AppContext } from '../http/context.js'
import { assertUsableWorkspace, resolveProjectFolderPaths } from './folder-path.js'
import { badRequest, conflict } from '../http/errors.js'

/** Clone destination directory. Counterpart to `assertUsableWorkspace`: ordinary projects require existing directories, while clones need free destinations. Existing empty directories are allowed because users may have run `mkdir` beforehand. */
export async function assertFreeDestination(parentDir: string, directory: string): Promise<string> {
  if (!isAbsolute(parentDir)) {
    throw badRequest('workspace_not_absolute', 'The workspace path must be absolute.')
  }
  // Directory names come from repository URLs: without this guard, `..` could direct
  // clones anywhere on disk.
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

/** Append to the list: inserting in the middle would visually move projects the user organized manually. */
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
  folderPaths: string[] = [],
) => {
  const [highest] = await ctx.db.select({ max: max(projects.position) }).from(projects)
  // Account defaults for future projects when creation supplies none.
  const defaults = readUserSettings(ctx.db, ownerId).projectDefaults

  const row = {
    id: randomUUID(),
    ...fields,
    // Fix at creation: resolving on every launch would switch modes when agents create
    // AGENTS.md. Without a choice, use account defaults; `auto` checks
    // files already present.
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
    crossProjects: false,
    agentTools: '{}',
    position: (highest?.max ?? 0) + 1,
    archivedAt: null,
    createdAt: Date.now(),
  }
  writeTransaction(ctx.db, tx => {
    tx.insert(projects).values(row).run()
    if (folderPaths.length) {
      tx.insert(projectFolders).values(folderPaths.map(path => ({ id: randomUUID(), projectId: row.id, path }))).run()
    }
  })
  return row
}

/** Shared with the interface to keep validation and initial values consistent. */
export async function createProject(ctx: AppContext, ownerId: string, input: unknown) {
  const body = createProjectBodySchema.parse(input)
  const workspacePath = 'workspacePath' in body
    ? await assertUsableWorkspace(body.workspacePath)
    : await assertFreeDestination(body.parentDir, body.directory)
  const folderPaths = await resolveProjectFolderPaths(workspacePath, body.folderPaths)
  if ('parentDir' in body) await mkdir(workspacePath, { recursive: true })
  return insertProject(ctx, ownerId, {
    name: body.name,
    workspacePath,
    visibility: body.visibility,
    color: body.color,
    instructionsMode: body.instructionsMode,
    memoryMode: body.memoryMode,
  }, folderPaths)
}
