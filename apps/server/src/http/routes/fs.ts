import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { browseQuerySchema, mkdirBodySchema, openExplorerFolderBodySchema, type ExplorerFolderDto, type FsEntryDto, type FsListingDto } from '@sillage/protocol'
import { and, eq } from 'drizzle-orm'
import { explorerFolders } from '@sillage/db'
import { canonicalExplorerFolder, isDeniedFolder } from '../../projects/folder-path.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/** Large directories must not produce multi-megabyte responses or block the event loop with stat() calls. */
const MAX_ENTRIES = 500

async function describeEntry(parentPath: string, name: string): Promise<FsEntryDto | null> {
  const path = join(parentPath, name)
  try {
    // Use stat rather than lstat: symlinks targeting directories are valid here.
    const info = await stat(path)
    if (!info.isDirectory()) return null
  } catch {
    // Broken symlink or inaccessible target: the entry is unusable.
    return null
  }

  let readable = true
  try {
    // R_OK permits listing, X_OK traversal. A single system call avoids a test readdir
    // that would read every entry in each of 500 subdirectories.
    await access(path, constants.R_OK | constants.X_OK)
  } catch {
    readable = false
  }

  return { name, path, isGitRepo: existsSync(join(path, '.git')), readable }
}

/** Roots offered alongside the home directory: `/`, or each available Windows drive because Windows has no common root. */
function systemRoots(): { label: string; path: string }[] {
  if (process.platform !== 'win32') return [{ label: 'Racine', path: '/' }]
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .map((letter) => ({ label: `${letter}:`, path: `${letter}:\\` }))
    .filter((root) => existsSync(root.path))
}

export function registerFsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const home = homedir()

  app.post('/api/explorer-folders', async (request): Promise<ExplorerFolderDto> => {
    const user = requireUser(request)
    const body = openExplorerFolderBodySchema.parse(request.body)
    const path = await canonicalExplorerFolder(body.path)

    // Opening the same folder in another panel must restore the same editor documents.
    ctx.db.insert(explorerFolders).values({ id: randomUUID(), userId: user.id, path })
      .onConflictDoNothing().run()
    return ctx.db.select({ id: explorerFolders.id, path: explorerFolders.path }).from(explorerFolders)
      .where(and(eq(explorerFolders.userId, user.id), eq(explorerFolders.path, path))).get()!
  })

  app.get('/api/fs/browse', async (request): Promise<FsListingDto> => {
    requireUser(request)
    const query = browseQuerySchema.parse(request.query)

    // resolve() normalizes '..' so returned values are canonical,
    // preventing paths such as /home/x/../../etc from appearing misleadingly different.
    const path = resolve(query.path ?? home)

    if (isDeniedFolder(path)) {
      throw forbidden('system_directory_denied', 'This system directory cannot be browsed.')
    }

    let info
    try {
      info = await stat(path)
    } catch {
      throw notFound('directory_not_found', 'Directory {path} does not exist.', { path })
    }
    if (!info.isDirectory())
      throw badRequest('not_a_directory', '{path} is not a directory.', { path })

    let names: string[]
    try {
      names = await readdir(path)
    } catch {
      throw forbidden('directory_read_denied', 'Read access to {path} was denied.', { path })
    }

    const visible = names
      .filter((name) => query.showHidden || !name.startsWith('.'))
      .filter((name) => !isDeniedFolder(join(path, name)))
      .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))

    const truncated = visible.length > MAX_ENTRIES
    const described = await Promise.all(
      visible.slice(0, MAX_ENTRIES).map((name) => describeEntry(path, name)),
    )

    const parent = dirname(path)

    return {
      path,
      parent: parent === path ? null : parent,
      entries: described.filter((entry): entry is FsEntryDto => entry !== null),
      isGitRepo: existsSync(join(path, '.git')),
      truncated,
      roots: [{ label: 'Accueil', path: home }, ...systemRoots()],
    }
  })

  app.post('/api/fs/mkdir', async (request): Promise<FsEntryDto> => {
    requireUser(request)
    const body = mkdirBodySchema.parse(request.body)

    // Names containing '/' (or '\\' on Windows) would target a different directory;
    // '.' and '..' are not meaningful names for new entries.
    const separator = body.name.includes('/') || (process.platform === 'win32' && body.name.includes('\\'))
    if (separator || body.name === '.' || body.name === '..') {
      throw badRequest('invalid_name', '{name} is not a valid folder name.', { name: body.name })
    }

    const parent = resolve(body.path)
    if (isDeniedFolder(parent)) {
      throw forbidden('system_directory_denied', 'This system directory cannot be browsed.')
    }

    const target = join(parent, body.name)
    if (existsSync(target)) {
      throw conflict('entry_exists', '{name} already exists.', { name: body.name })
    }

    try {
      await mkdir(target)
    } catch (err) {
      throw badRequest('create_failed', 'Could not create {name}: {reason}.', {
        name: body.name,
        reason: err instanceof Error ? err.message : String(err),
      })
    }

    const entry = await describeEntry(parent, body.name)
    if (!entry) {
      throw badRequest('create_failed', 'Could not create {name}: {reason}.', {
        name: body.name,
        reason: 'directory unreadable right after creation',
      })
    }
    return entry
  })
}
