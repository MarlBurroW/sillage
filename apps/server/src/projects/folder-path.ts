import { constants, realpathSync } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { samePath } from '../agents/paths.js'
import { badRequest, forbidden, notFound } from '../http/errors.js'

const DENIED_PREFIXES = ['/proc', '/sys', '/dev', '/run']

export function isDeniedFolder(path: string): boolean {
  return DENIED_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

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

export async function canonicalExplorerFolder(input: string): Promise<string> {
  const absolute = await assertUsableWorkspace(input)
  const path = await realpath(absolute).catch(() => {
    throw notFound('directory_not_found', 'Directory {path} does not exist.', { path: absolute })
  })
  if (isDeniedFolder(path)) {
    throw forbidden('system_directory_denied', 'This system directory cannot be browsed.')
  }
  await access(path, constants.R_OK | constants.X_OK).catch(() => {
    throw forbidden('directory_read_denied', 'Read access to {path} was denied.', { path })
  })
  return path
}

// A new or missing main directory has no real path yet. Its configured path still identifies it.
export function canonicalMainFolder(workspacePath: string): string {
  try { return realpathSync.native(workspacePath) }
  catch { return resolve(workspacePath) }
}

export function assertAdditionalFolder(main: string, path: string): void {
  if (samePath(main, path)) {
    throw badRequest('project_folder_primary', 'This folder is already the main project directory.')
  }
}

export async function resolveProjectFolderPaths(workspacePath: string, paths: string[] = []): Promise<string[]> {
  if (!paths.length) return []
  // Creation validates attachments before making the main directory or starting a clone.
  const main = canonicalMainFolder(workspacePath)
  const folders = new Set<string>()
  for (const input of paths) {
    const path = await canonicalExplorerFolder(input)
    assertAdditionalFolder(main, path)
    folders.add(path)
  }
  return [...folders]
}
