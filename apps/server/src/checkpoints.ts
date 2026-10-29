import { execFile } from 'node:child_process'
import { cp, lstat, mkdtemp, rm, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CheckpointFile } from '@sillage/protocol'

/** Turn checkpoints capture workspace state before and after execution. Each snapshot is a git tree under `refs/sillage/checkpoints/`, never a commit: the user's branch, index and HEAD stay unchanged; `git log --all` sees nothing because tree refs have no history. Objects live in the repository, allowing git to diff snapshots and `checkout-index` to restore files. Capture uses a temporary index (`GIT_INDEX_FILE`) copied from the real one to reuse its stat cache: on large repositories `git add -u` hashes only changed files. Ignored files and untracked files above `MAX_UNTRACKED_BYTES` are excluded so uploaded archives do not enter the object store each turn. Refs are shared across repository worktrees but named by conversation and turn, preventing collisions. */

/** Capture or restore exceeding this duration indicates an unusable repository. */
const TIMEOUT_MS = 60_000

/** Larger untracked files are neither captured nor deleted during restoration. */
export const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024

/** Beyond this size, file diffs are no longer useful to display. */
const MAX_PATCH_BYTES = 512 * 1024

export class CheckpointError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail || code)
    this.name = 'CheckpointError'
  }
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown }
          if (failure.killed) {
            reject(new CheckpointError('checkpoint_timeout', `git ${args[0]} took too long and was stopped.`))
            return
          }
          if (typeof failure.code !== 'number') {
            reject(new CheckpointError('checkpoint_git_failed', `git could not be started: ${failure.message}`))
            return
          }
          resolvePromise({ code: failure.code, stdout, stderr })
          return
        }
        resolvePromise({ code: 0, stdout, stderr })
      },
    )
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

/** Command whose failure is an error: return output or throw. */
async function read(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const result = await run(cwd, args, env, input)
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(0, 3).join(' ') || `git ${args[0]} exited with ${result.code}`
    throw new CheckpointError('checkpoint_git_failed', detail)
  }
  return result.stdout
}

function splitZ(raw: string): string[] {
  return raw.split('\0').filter((field) => field.length > 0)
}

interface Repo {
  /** Worktree root as resolved by git. */
  top: string
  /** Conversation directory relative to the root, with trailing `/`, or empty. */
  prefix: string
  /** Absolute path of the index file; worktrees keep theirs outside the main `.git`. */
  index: string
}

/** Repository location and conversation directory within it. Projects may target subdirectories: capture and restore then affect only that subtree and return relative paths like the rest of the panel. Null outside repositories because projects may point anywhere. The index path rides along in the same call: every git process costs tens of milliseconds on Windows, and capture runs before each turn. */
async function locate(cwd: string): Promise<Repo | null> {
  const result = await run(cwd, ['rev-parse', '--show-toplevel', '--show-prefix', '--git-path', 'index'])
  if (result.code !== 0) return null
  const [top, prefix, index] = result.stdout.split('\n')
  if (!top || !index) return null
  return { top, prefix: prefix ?? '', index: resolve(cwd, index) }
}

/** Pathspec limiting commands to the conversation directory. */
function scopeOf(repo: Repo): string[] {
  return repo.prefix ? ['--', repo.prefix] : []
}

function stripPrefix(repo: Repo, path: string): string {
  return repo.prefix && path.startsWith(repo.prefix) ? path.slice(repo.prefix.length) : path
}

export type CheckpointPhase = 'before' | 'after'

function refBase(conversationId: string): string {
  return `refs/sillage/checkpoints/${conversationId}`
}

export function checkpointRef(conversationId: string, key: string, phase: CheckpointPhase): string {
  return `${refBase(conversationId)}/${key}/${phase}`
}

export interface Snapshot {
  ref: string
  /** Working-directory tree: tracked and untracked files, excluding ignored files. */
  tree: string
  /** Index tree at the same instant; null when conflicts existed. */
  indexTree: string | null
  /** HEAD at the same instant; null for repositories without commits. */
  head: string | null
}

interface Meta {
  head: string | null
  indexTree: string | null
  ts: number
}

/** Captures workspace state under a ref. Conflicted files are captured exactly as on disk, including markers. The index cannot become a tree while it has unmerged entries; record it as absent and leave it unchanged during restoration. */
export async function captureSnapshot(cwd: string, ref: string): Promise<Snapshot> {
  const repo = await locate(cwd)
  if (!repo) throw new CheckpointError('checkpoint_not_repository', 'This directory is not inside a git repository.')

  const tmp = await mkdtemp(join(tmpdir(), 'sillage-checkpoint-'))
  try {
    const workIndex = join(tmp, 'work')
    const snapIndex = join(tmp, 'snap')
    // Newly initialized repositories have no index yet: start from nothing.
    await Promise.all([cp(repo.index, workIndex).catch(() => {}), cp(repo.index, snapIndex).catch(() => {})])

    // The working-tree walk, the index tree and HEAD are independent: run them side by side.
    // Sends wait for this capture, and sequential git processes made Windows users wait seconds
    // after pressing Enter. Each process has its own index file or none, so nothing races.
    const scope = scopeOf(repo)
    const [tree, indexTree, head] = await Promise.all([
      captureWorkTree(repo, workIndex, scope),
      run(repo.top, ['write-tree'], { GIT_INDEX_FILE: snapIndex }).then((result) => (result.code === 0 ? result.stdout.trim() : null)),
      run(repo.top, ['rev-parse', '--verify', '-q', 'HEAD']).then((result) => (result.code === 0 ? result.stdout.trim() : null)),
    ])

    const meta: Meta = { head, indexTree, ts: Date.now() }
    const metaBlob = (await read(repo.top, ['hash-object', '-w', '--stdin'], undefined, JSON.stringify(meta))).trim()
    const wrapper = (
      await read(
        repo.top,
        ['mktree', '-z'],
        undefined,
        [
          `040000 tree ${tree}\tworktree`,
          ...(indexTree ? [`040000 tree ${indexTree}\tindex`] : []),
          `100644 blob ${metaBlob}\tmeta`,
        ].join('\0') + '\0',
      )
    ).trim()
    await read(repo.top, ['update-ref', ref, wrapper])

    return { ref, tree, indexTree, head }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Tree of tracked and untracked files as on disk, built in a scratch index so the real one is never touched. */
async function captureWorkTree(repo: Repo, workIndex: string, scope: string[]): Promise<string> {
  const work = { GIT_INDEX_FILE: workIndex }
  await read(repo.top, ['add', '-u', '--ignore-errors', '--', repo.prefix || '.'], work)

  const untracked = splitZ(await read(repo.top, ['ls-files', '-z', '-o', '--exclude-standard', ...scope], work))
  const infos = await Promise.all(untracked.map((path) => lstat(join(repo.top, path)).catch(() => null)))
  const kept = untracked.filter((_, i) => {
    const info = infos[i]
    if (!info) return false
    if (info.isFile() && info.size > MAX_UNTRACKED_BYTES) return false
    return info.isFile() || info.isSymbolicLink()
  })
  if (kept.length > 0) {
    await read(repo.top, ['update-index', '--add', '-z', '--stdin'], work, `${kept.join('\0')}\0`)
  }
  return (await read(repo.top, ['write-tree'], work)).trim()
}

/** Rereads a snapshot. Null if its ref is gone (cleaned conversation or recloned repository). */
export async function readSnapshot(cwd: string, ref: string): Promise<Snapshot | null> {
  const repo = await locate(cwd)
  if (!repo) return null
  const exists = await run(repo.top, ['rev-parse', '--verify', '-q', `${ref}^{tree}`])
  if (exists.code !== 0) return null

  const tree = (await read(repo.top, ['rev-parse', `${ref}:worktree`])).trim()
  let meta: Meta = { head: null, indexTree: null, ts: 0 }
  try {
    meta = JSON.parse(await read(repo.top, ['cat-file', '-p', `${ref}:meta`])) as Meta
  } catch {
    // Snapshots without metadata remain usable; only their original HEAD is unknown.
  }
  return { ref, tree, indexTree: meta.indexTree ?? null, head: meta.head ?? null }
}

const KINDS: Record<string, CheckpointFile['kind']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
}

/** Added and removed lines per file from `--numstat -z`. Renames occupy three fields: counters with an empty path, then old and new names. */
function parseNumstat(raw: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field) continue
    const [added, removed, path] = field.split('\t')
    if (path === undefined) continue
    const target = path === '' ? fields[(i += 2)] : path
    if (!target) continue
    counts.set(target, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    })
  }
  return counts
}

/** Change types from `--name-status -z`; R and C entries have two paths. */
function parseNameStatus(raw: string): CheckpointFile[] {
  const fields = splitZ(raw)
  const files: CheckpointFile[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i]?.[0] ?? ''
    const kind = KINDS[status]
    if (!kind) continue
    if (status === 'R' || status === 'C') {
      const oldPath = fields[i + 1] ?? ''
      const path = fields[i + 2] ?? ''
      i += 2
      files.push({ path, oldPath, kind, added: null, removed: null })
    } else {
      const path = fields[i + 1] ?? ''
      i += 1
      files.push({ path, oldPath: null, kind, added: null, removed: null })
    }
  }
  return files
}

export interface CheckpointDiff {
  files: CheckpointFile[]
  /** Files introduced by git during the turn (pull, merge, rebase), excluded from changes. */
  excluded: number
}

/** Journal path resolved relative to the repository root. */
function toRepoPath(repo: Repo, cwd: string, path: string): string | null {
  const rel = isAbsolute(path) ? relative(repo.top, path) : relative(repo.top, resolve(cwd, path))
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** Changes between the turn's snapshots. When HEAD moved, exclude files changed between those HEADs unless the agent edited them: pull and merge bring files unrelated to the turn's work. Agent-edited files remain even if committed afterward. Known limitation: files modified through shell commands outside editing tools and then committed are also excluded. */
export async function diffCheckpoint(
  cwd: string,
  conversationId: string,
  key: string,
  edited: string[],
): Promise<CheckpointDiff> {
  const repo = await locate(cwd)
  if (!repo) throw new CheckpointError('checkpoint_not_repository', 'This directory is not inside a git repository.')
  const before = await readSnapshot(cwd, checkpointRef(conversationId, key, 'before'))
  const after = await readSnapshot(cwd, checkpointRef(conversationId, key, 'after'))
  if (!before || !after) {
    throw new CheckpointError('checkpoint_missing', 'The captures of this turn are no longer in the repository.')
  }

  const scope = scopeOf(repo)
  const [numstat, nameStatus] = await Promise.all([
    read(repo.top, ['diff-tree', '-r', '-M', '-z', '--numstat', before.tree, after.tree, ...scope]),
    read(repo.top, ['diff-tree', '-r', '-M', '-z', '--name-status', before.tree, after.tree, ...scope]),
  ])
  const counts = parseNumstat(numstat)

  let broughtByGit = new Set<string>()
  if (before.head && after.head && before.head !== after.head) {
    // Rewritten HEADs may no longer resolve, preventing exclusion.
    const moved = await run(repo.top, ['diff-tree', '-r', '-z', '--name-only', before.head, after.head, ...scope])
    if (moved.code === 0) broughtByGit = new Set(splitZ(moved.stdout))
  }
  const editedSet = new Set(edited.map((path) => toRepoPath(repo, cwd, path)).filter((path) => path !== null))

  let excluded = 0
  const files: CheckpointFile[] = []
  for (const file of parseNameStatus(nameStatus)) {
    const own = editedSet.has(file.path) || (file.oldPath !== null && editedSet.has(file.oldPath))
    if (!own && broughtByGit.has(file.path)) {
      excluded += 1
      continue
    }
    files.push({
      ...file,
      path: stripPrefix(repo, file.path),
      oldPath: file.oldPath === null ? null : stripPrefix(repo, file.oldPath),
      ...counts.get(file.path),
    })
  }
  return { files, excluded }
}

/** File diff between snapshots, read only when expanded. */
export async function readCheckpointFileDiff(
  cwd: string,
  conversationId: string,
  key: string,
  path: string,
  oldPath: string | null,
): Promise<{ patch: string; truncated: boolean }> {
  const repo = await locate(cwd)
  if (!repo) throw new CheckpointError('checkpoint_not_repository', 'This directory is not inside a git repository.')
  const before = await readSnapshot(cwd, checkpointRef(conversationId, key, 'before'))
  const after = await readSnapshot(cwd, checkpointRef(conversationId, key, 'after'))
  if (!before || !after) {
    throw new CheckpointError('checkpoint_missing', 'The captures of this turn are no longer in the repository.')
  }

  const paths = [repo.prefix + path, ...(oldPath ? [repo.prefix + oldPath] : [])]
  const patch = await read(repo.top, ['diff-tree', '-r', '-p', '-M', before.tree, after.tree, '--', ...paths])
  const truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES
  return { patch: truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch, truncated }
}

export interface RestoreResult {
  written: number
  deleted: number
  indexRestored: boolean
}

/** Removes directories left empty by deletion without ascending beyond the root. */
async function pruneEmptyDirs(top: string, path: string): Promise<void> {
  let dir = dirname(resolve(top, path))
  while (dir.startsWith(top) && dir !== top) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

/** Restores workspace state from a snapshot. Rewrite only differences: a temporary index loaded from the snapshot tree and refreshed identifies exactly which files need `checkout-index`. Rewriting everything would change timestamps and trigger full rebuilds. Delete newly appeared tracked and untracked files except ignored files and untracked files too large to have been captured. Restore the real index only for affected paths; leave HEAD and commits unchanged. Turns that committed retain their commits, with restored files appearing as modifications against them. */
export async function restoreSnapshot(cwd: string, ref: string): Promise<RestoreResult> {
  const repo = await locate(cwd)
  if (!repo) throw new CheckpointError('checkpoint_not_repository', 'This directory is not inside a git repository.')
  const snapshot = await readSnapshot(cwd, ref)
  if (!snapshot) throw new CheckpointError('checkpoint_missing', 'The capture of this turn is no longer in the repository.')

  const scope = scopeOf(repo)
  const tmp = await mkdtemp(join(tmpdir(), 'sillage-restore-'))
  try {
    const work = { GIT_INDEX_FILE: join(tmp, 'index') }
    await read(repo.top, ['read-tree', snapshot.tree], work)
    // Exit 1 means files differ: this is the answer being requested, not an error.
    await run(repo.top, ['update-index', '--refresh', '-q'], work)
    const changed = splitZ(await read(repo.top, ['diff-files', '-z', '--name-only', ...scope], work))
    if (changed.length > 0) {
      await read(repo.top, ['checkout-index', '-f', '-q', '-z', '--stdin'], work, `${changed.join('\0')}\0`)
    }

    const captured = new Set(splitZ(await read(repo.top, ['ls-tree', '-r', '-z', '--name-only', snapshot.tree, ...scope])))
    const tracked = new Set(splitZ(await read(repo.top, ['ls-files', '-z', ...scope])))
    const untracked = splitZ(await read(repo.top, ['ls-files', '-z', '-o', '--exclude-standard', ...scope]))

    const deleted: string[] = []
    for (const path of [...tracked, ...untracked]) {
      if (captured.has(path)) continue
      const info = await lstat(join(repo.top, path)).catch(() => null)
      if (!info) continue
      if (info.isFile() && info.size > MAX_UNTRACKED_BYTES && !tracked.has(path)) continue
      await unlink(join(repo.top, path))
      await pruneEmptyDirs(repo.top, path)
      deleted.push(path)
    }

    if (snapshot.indexTree) {
      const staged = splitZ(
        (await run(repo.top, ['diff-index', '--cached', '-z', '--name-only', snapshot.indexTree, ...scope])).stdout,
      )
      const touched = new Set([...changed, ...deleted, ...staged])
      const entries = new Map<string, string>()
      for (const line of splitZ(await read(repo.top, ['ls-tree', '-r', '-z', snapshot.indexTree, ...scope]))) {
        const [info, path] = line.split('\t')
        if (!info || !path) continue
        const [mode, , sha] = info.split(' ')
        if (mode && sha) entries.set(path, `${mode} ${sha}\t${path}`)
      }
      const keep: string[] = []
      const drop: string[] = []
      for (const path of touched) {
        const entry = entries.get(path)
        if (entry) keep.push(entry)
        else drop.push(path)
      }
      if (keep.length > 0) await read(repo.top, ['update-index', '-z', '--index-info'], undefined, `${keep.join('\0')}\0`)
      if (drop.length > 0) await read(repo.top, ['update-index', '-z', '--force-remove', '--stdin'], undefined, `${drop.join('\0')}\0`)
    }

    return { written: changed.length, deleted: deleted.length, indexRestored: snapshot.indexTree !== null }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Gives forked conversations their source snapshots. Copied journals use the same keys and would otherwise show markers with no target. Refs point to the same trees without duplicating object-store data; conversations then retain independent refs so cleaning either does not affect the other. */
export async function copyCheckpoints(cwd: string, fromId: string, toId: string): Promise<number> {
  const repo = await locate(cwd)
  if (!repo) return 0
  const base = `${refBase(fromId)}/`
  const entries = (await read(repo.top, ['for-each-ref', '--format=%(objectname) %(refname)', base]))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (entries.length === 0) return 0
  const script = entries
    .map((entry) => {
      const [object, ref] = entry.split(' ')
      return `create ${refBase(toId)}/${ref!.slice(base.length)} ${object}\n`
    })
    .join('')
  await read(repo.top, ['update-ref', '--stdin'], undefined, script)
  return entries.length
}

/** Removes all conversation snapshots. No effect outside git or without snapshots. */
export async function deleteCheckpoints(cwd: string, conversationId: string): Promise<number> {
  const repo = await locate(cwd)
  if (!repo) return 0
  const refs = (await read(repo.top, ['for-each-ref', '--format=%(refname)', `${refBase(conversationId)}/`]))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (refs.length === 0) return 0
  await read(repo.top, ['update-ref', '--stdin'], undefined, refs.map((ref) => `delete ${ref}\n`).join(''))
  return refs.length
}
