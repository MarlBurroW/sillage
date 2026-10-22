import { createWriteStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { eq } from 'drizzle-orm'
import { conversations, projects, worktrees, type ConversationRow, type Db } from '@sillage/db'
import { MAX_UPLOAD_BYTES, type TreeEntryDto } from '@sillage/protocol'
import { HttpError, notFound } from './http/errors.js'

/**
 * Conversation working directory and boundaries for paths inside it.
 *
 * Extracted from the session manager because the side panel needs it even when
 * no session is running: browsing the tree does not require a running agent.
 */

/** One level per request: expanding an entire `node_modules` takes megabytes. */
const MAX_ENTRIES = 1000

/**
 * Working directory of a conversation this account is allowed to view.
 *
 * Visibility is checked alongside path resolution instead of being copied into
 * every panel route: three copies mean three places to forget it. Denied access
 * returns 'not found', like the rest of the API: distinguishing the two would
 * reveal to a third party that a conversation exists.
 */
export function conversationWorkspace(db: Db, conversationId: string, userId: string): string {
  const row = db
    .select({
      conversation: conversations,
      ownerId: projects.ownerId,
      visibility: projects.visibility,
    })
    .from(conversations)
    .innerJoin(projects, eq(projects.id, conversations.projectId))
    .where(eq(conversations.id, conversationId))
    .get()

  if (!row) throw notFound('conversation_not_found', 'Conversation not found.')
  if (row.ownerId !== userId && row.visibility !== 'shared') {
    throw notFound('conversation_not_found', 'Conversation not found.')
  }
  return resolveConversationCwd(db, row.conversation)
}

/**
 * Workspace of a project this account is allowed to view. Counterpart to
 * `conversationWorkspace` for the project panel, where no conversation exists.
 */
export function projectWorkspace(db: Db, projectId: string, userId: string): string {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row || (row.ownerId !== userId && row.visibility !== 'shared')) {
    throw notFound('project_not_found', 'Project not found.')
  }
  return row.workspacePath
}

/**
 * Directory targeted by a conversation draft: its worktree when specified,
 * otherwise the project workspace.
 *
 * Uses the same policy as existing conversations (`resolveConversationCwd`): a
 * removed worktree falls back to the workspace so `@` mentions, `/` commands and
 * conversation creation all resolve from the same directory. A worktree belonging
 * to another project is not found: its identifier must not grant access elsewhere.
 */
export function projectCwd(
  db: Db,
  projectId: string,
  userId: string,
  worktreeId: string | null | undefined,
): string {
  const workspace = projectWorkspace(db, projectId, userId)
  if (!worktreeId) return workspace

  const worktree = db.select().from(worktrees).where(eq(worktrees.id, worktreeId)).get()
  if (!worktree || worktree.projectId !== projectId) {
    throw notFound('worktree_not_found', 'Worktree not found.')
  }
  return worktree.removedAt ? workspace : worktree.path
}

export function resolveConversationCwd(db: Db, conversation: Pick<ConversationRow, 'worktreeId' | 'projectId'>): string {
  if (conversation.worktreeId) {
    const worktree = db
      .select()
      .from(worktrees)
      .where(eq(worktrees.id, conversation.worktreeId))
      .get()
    if (worktree && !worktree.removedAt) return worktree.path
  }

  const project = db.select().from(projects).where(eq(projects.id, conversation.projectId)).get()
  if (!project) throw notFound('project_not_found', 'Project not found.')
  return project.workspacePath
}

/**
 * Absolute path to a workspace entry, rejected if it escapes the workspace.
 *
 * Without this boundary, `..` in a path would give anyone with access to a shared
 * project a file browser for the entire machine.
 */
export function resolveInside(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath)
  const inside = relative(root, absolute)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new HttpError(
      400,
      'path_outside_workspace',
      'Path {path} is outside the working directory.',
      { path: relativePath },
    )
  }
  return absolute
}

/** Like `resolveInside`, but also returns the name for `@` mentions. */
export function resolveMention(
  root: string,
  relativePath: string,
): { relativePath: string; path: string; name: string } {
  const path = resolveInside(root, relativePath)
  return { relativePath, path, name: basename(path) }
}

/**
 * Rejects any path passing through `.git`.
 *
 * The explorer already hides this directory, but the interface is not the
 * safeguard: renaming or deleting git storage through a direct request would
 * destroy the repository history with no way to recover it.
 */
export function refuseGitInternals(relativePath: string): void {
  if (relativePath.split('/').includes('.git')) {
    throw new HttpError(400, 'git_internals', 'The .git folder cannot be manipulated here.')
  }
}

async function exists(absolute: string): Promise<boolean> {
  return stat(absolute).then(
    () => true,
    () => false,
  )
}

/** Creates an empty file or directory. Refuses to overwrite an existing entry. */
export async function createEntry(
  root: string,
  parent: string,
  name: string,
  kind: 'file' | 'directory',
): Promise<string> {
  const relativePath = parent ? `${parent}/${name}` : name
  refuseGitInternals(relativePath)

  const absolute = resolveInside(root, relativePath)
  if (await exists(absolute)) {
    throw new HttpError(409, 'entry_exists', '{name} already exists.', { name })
  }

  try {
    if (kind === 'directory') await mkdir(absolute, { recursive: true })
    // `wx` fails if the file appears between checking and writing:
    // the check above informs the caller; this one enforces the rule.
    else await writeFile(absolute, '', { flag: 'wx' })
  } catch (err) {
    throw new HttpError(400, 'create_failed', 'Could not create {name}: {reason}.', {
      name,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  return relativePath
}

/**
 * Streams a file uploaded through the explorer.
 *
 * Content is never assembled in memory: a hundred-megabyte upload would fit in
 * the server heap, but ten simultaneous uploads would not. Missing directories
 * are created so dropping an entire folder preserves its structure.
 *
 * `wx` rejects existing files: silently overwriting an agent's work because a
 * drop missed its target would cause an unnoticed loss. The filesystem enforces
 * this instead of a preliminary `stat`, which would leave a race between checking
 * and writing.
 */
export async function writeUpload(
  root: string,
  relativePath: string,
  content: Readable,
  onTooLarge: () => boolean,
): Promise<void> {
  refuseGitInternals(relativePath)

  const absolute = resolveInside(root, relativePath)
  await mkdir(dirname(absolute), { recursive: true })

  // Uses a different code from attachments: the two limits differ in both
  // value and scale, and sharing one message would say
  // 'maximum 10240 MB' where gigabytes are expected.
  const tooLarge = (): never => {
    throw new HttpError(413, 'upload_too_large', 'File is too large (maximum {maxGb} GB).', {
      maxGb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024),
    })
  }

  try {
    await pipeline(content, createWriteStream(absolute, { flags: 'wx' }))

    // The multipart stream stops at the limit without always reporting an error:
    // without this check, an oversized file was truncated and reported as received.
    if (onTooLarge()) {
      await unlink(absolute).catch(() => {})
      tooLarge()
    }
  } catch (err) {
    if (err instanceof HttpError) throw err

    // A partial file is worse than no file: the tree would show an apparently
    // normal entry truncated halfway through. Unless opening failed, in which
    // case it belongs to someone else and must never be removed.
    const existed = (err as NodeJS.ErrnoException).code === 'EEXIST'
    if (!existed) await unlink(absolute).catch(() => {})

    if (existed) {
      throw new HttpError(409, 'entry_exists', '{name} already exists.', { name: relativePath })
    }
    if (onTooLarge()) tooLarge()
    throw new HttpError(400, 'upload_failed', 'Could not write {path}: {reason}.', {
      path: relativePath,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Renames or moves an entry: both are the same operation with a different path.
 *
 * Creates the destination directory when needed so moving to a deeply nested
 * path does not require preparing it first.
 */
export async function moveEntry(root: string, from: string, to: string): Promise<void> {
  refuseGitInternals(from)
  refuseGitInternals(to)

  const source = resolveInside(root, from)
  const destination = resolveInside(root, to)
  if (source === destination) return

  // Moving a directory into itself would destroy its contents: `rename` rejects
  // it on some systems and accepts it on others, so enforce the rule here.
  if (destination.startsWith(`${source}/`)) {
    throw new HttpError(400, 'move_into_self', 'A folder cannot be moved into itself.')
  }
  if (await exists(destination)) {
    throw new HttpError(409, 'entry_exists', '{name} already exists.', { name: to })
  }

  try {
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
  } catch (err) {
    throw new HttpError(400, 'move_failed', 'Could not move {from} to {to}: {reason}.', {
      from,
      to,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Like `resolveInside`, but also checks the real path.
 *
 * Lexical boundaries cannot see symlinks: `link/secret` stays 'inside' the workspace
 * even if `link` points to `/etc`. Anything reading an entry to copy or export its
 * contents must therefore check where it actually leads.
 */
export async function resolveRealInside(root: string, relativePath: string): Promise<string> {
  const absolute = resolveInside(root, relativePath)
  const resolved = await Promise.all([realpath(root), realpath(absolute)]).catch(() => null)
  if (!resolved) throw notFound('entry_not_found', 'Entry not found.')
  resolveInside(resolved[0], resolved[1])
  return absolute
}

/** Suggested name at the nth collision: `nom copy.ext`, then `nom copy 2.ext`… */
function copyName(name: string, isDirectory: boolean, attempt: number): string {
  if (attempt === 0) return name
  // An extensionless hidden file (`.env`) has no dot to preserve at the end.
  const dot = isDirectory ? -1 : name.lastIndexOf('.')
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return `${stem} copy${attempt > 1 ? ` ${attempt}` : ''}${extension}`
}

/** Beyond this point, collisions are no accident and further searching is pointless. */
const MAX_COPY_ATTEMPTS = 100

/**
 * Copies an entry into a directory, including a directory's contents, and returns
 * the created path.
 *
 * The name never matches an existing entry: pasting where that name already exists
 * is the common case (duplicating in place), and overwriting is never intended.
 * Symlinks inside the entry are copied as-is rather than followed, which would
 * bring their targets into the workspace.
 */
export async function copyEntry(root: string, from: string, toParent: string): Promise<string> {
  refuseGitInternals(from)
  refuseGitInternals(toParent)

  const source = await resolveRealInside(root, from)
  const parent = resolveInside(root, toParent)
  if (parent === source || parent.startsWith(`${source}/`)) {
    throw new HttpError(400, 'copy_into_self', 'A folder cannot be copied into itself.')
  }
  if (!(await stat(parent).catch(() => null))?.isDirectory()) {
    throw notFound('directory_not_found', 'Directory {path} does not exist.', { path: toParent })
  }

  const isDirectory = (await lstat(source)).isDirectory()
  const name = basename(source)
  for (let attempt = 0; attempt < MAX_COPY_ATTEMPTS; attempt += 1) {
    const candidate = copyName(name, isDirectory, attempt)
    const destination = resolveInside(parent, candidate)
    if (await exists(destination)) continue

    try {
      await cp(source, destination, {
        recursive: true,
        // The name was just found to be free, but may not remain so:
        // copying refuses to overwrite anything that appeared in the meantime.
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      })
    } catch (err) {
      // A partial copy would look successful. The name was free just now, so
      // anything there comes from this copy, unless a collision is precisely
      // what caused it to fail.
      if ((err as NodeJS.ErrnoException).code !== 'ERR_FS_CP_EEXIST') {
        await rm(destination, { recursive: true, force: true }).catch(() => {})
      }
      throw new HttpError(400, 'copy_failed', 'Could not copy {from}: {reason}.', {
        from,
        reason: err instanceof Error ? err.message : String(err),
      })
    }

    return toParent ? `${toParent}/${candidate}` : candidate
  }

  throw new HttpError(409, 'entry_exists', '{name} already exists.', { name })
}

/** Deletes an entry, including a directory and its contents. */
export async function deleteEntry(root: string, relativePath: string): Promise<void> {
  refuseGitInternals(relativePath)

  const absolute = resolveInside(root, relativePath)
  if (absolute === resolve(root)) {
    throw new HttpError(400, 'delete_root', 'The working directory cannot be deleted.')
  }
  if (!(await exists(absolute))) throw notFound('entry_not_found', 'Entry not found.')

  try {
    await rm(absolute, { recursive: true, force: true })
  } catch (err) {
    throw new HttpError(400, 'delete_failed', 'Could not delete {path}: {reason}.', {
      path: relativePath,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * One level of the tree, directories first then files, each sorted by name.
 *
 * Symlinks are not followed (`withFileTypes` returns their own type): a link to
 * the root would make the explorer loop, and following it would bypass the
 * workspace boundary.
 */
/**
 * Directories excluded from search.
 *
 * They remain visible in the explorer, where expanding them is deliberate;
 * traversing them to find a file is different: `node_modules` alone outweighs
 * the rest of the repository, and its results are never what we are looking for.
 */
const SEARCH_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.venv',
  '__pycache__',
  '.pnpm-store',
  'coverage',
])

/** Beyond this limit the list is unreadable and traversal costs more than it yields. */
const SEARCH_MAX_RESULTS = 80
const SEARCH_MAX_VISITED = 30_000

/**
 * Searches for a file by name throughout the working directory.
 *
 * Uses case- and accent-insensitive substring matching rather than fuzzy matching:
 * in a project tree, fuzzy matching mostly adds noise, and users almost always
 * enter an exact part of the name. Name matches precede path matches, and shorter
 * matches precede longer ones because `panel.ts` is a likelier target than
 * `panel-transition-helpers.ts`.
 *
 * Traversal is bounded in both breadth and depth: a working directory can be
 * anything, including a network mount.
 */
export async function searchEntries(
  root: string,
  query: string,
): Promise<{ entries: TreeEntryDto[]; truncated: boolean }> {
  const needle = fold(query)
  const found: TreeEntryDto[] = []
  const queue: string[] = ['']
  let visited = 0
  let truncated = false

  while (queue.length > 0) {
    const relative = queue.shift() as string

    let entries
    try {
      entries = await readdir(resolveInside(root, relative), { withFileTypes: true })
    } catch {
      // An unreadable directory (permissions, broken link) does not stop the search:
      // it is simply skipped.
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue

      visited += 1
      if (visited > SEARCH_MAX_VISITED) {
        truncated = true
        return { entries: rank(found, needle), truncated }
      }

      const path = relative ? `${relative}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (!SEARCH_SKIP.has(entry.name)) queue.push(path)
        continue
      }

      if (!fold(path).includes(needle)) continue

      found.push({ name: entry.name, path, isDirectory: false })
      if (found.length >= SEARCH_MAX_RESULTS) {
        truncated = true
        return { entries: rank(found, needle), truncated }
      }
    }
  }

  return { entries: rank(found, needle), truncated }
}

/** Removes case and accents: searching for 'recu' must find 'reçu'. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

function rank(entries: TreeEntryDto[], needle: string): TreeEntryDto[] {
  return entries.sort((a, b) => {
    const inNameA = fold(a.name).includes(needle)
    const inNameB = fold(b.name).includes(needle)
    if (inNameA !== inNameB) return inNameA ? -1 : 1
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    return a.path.localeCompare(b.path, 'fr')
  })
}

export async function listDirectory(root: string, relativePath: string): Promise<TreeEntryDto[]> {
  const absolute = resolveInside(root, relativePath)

  let entries
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch (err) {
    throw new HttpError(404, 'directory_unreadable', 'Directory {path} is unreadable: {reason}.', {
      path: relativePath,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  const listed: TreeEntryDto[] = entries
    // `.git` stores git data rather than project content: opening it makes no
    // sense and would expose the root's largest subtree. Other hidden files
    // remain visible because `.gitignore` is ordinary project content.
    .filter((entry) => entry.name !== '.git')
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({
      name: entry.name,
      path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
      isDirectory: entry.isDirectory(),
    }))

  return listed.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'fr')
  })
}
