import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { WorktreeFileDto, WorktreeState } from '@sillage/protocol'

/** Worktree progress against the repository default branch. Ask whether anything remains absent from the base, rather than whether the branch is an ancestor of main: squash, cherry-pick and manual copying can merge content without ancestry, while never-committed worktrees can look merged despite holding all the work. Compare content through `git merge-tree`, which calculates merges without touching worktrees or refs. All operations are reads except temporary objects left by `merge-tree` and `stash create`, later collected by `gc`. */

/** State reads with generous timeout for cold large repositories. */
const READ_TIMEOUT_MS = 15_000

/** Beyond this limit, comparing untracked files against the base costs more than it informs. */
const MAX_UNTRACKED_COMPARED = 500

/** Number of file timestamps read to estimate the latest modification. */
const MAX_FILES_STATTED = 200

/** Files listed per tree: enough to recognise leftovers, small enough for every sidebar poll. */
const MAX_FILES_LISTED = 30

/** Beyond this many leftover files, offering to keep them all at once would be a blind gesture. */
const MAX_FILES_FINGERPRINTED = 2_000

interface GitResult {
  code: number
  stdout: string
}

/** Git wrapper exposing exit codes: `merge-tree` returns 1 for conflicts while still producing a tree, which exceptions would hide. */
function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, timeout: READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        const code = (err as { code?: unknown } | null)?.code
        if (err && typeof code !== 'number') return reject(err)
        resolve({ code: typeof code === 'number' ? code : 0, stdout })
      },
    )
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

async function out(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args)
  if (result.code !== 0) throw new Error(`git ${args[0]} a répondu ${result.code}`)
  return result.stdout
}

const line = async (cwd: string, args: string[]): Promise<string> => (await out(cwd, args)).trim()

export interface WorktreeEntry {
  path: string
  head: string | null
  /** Short branch name; null for detached HEAD. */
  branch: string | null
  /** Whether this is the main repository worktree. */
  main: boolean
  /** Git already knows the directory is gone: the entry only awaits `prune`. */
  prunable: boolean
}

/** Git-known worktrees, main tree first. Empty outside repositories. */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  let raw: string
  try {
    raw = await out(repo, ['worktree', 'list', '--porcelain', '-z'])
  } catch {
    return []
  }

  return parseWorktreeList(raw)
}

/** NUL mode preserves accented characters and newlines in paths. Git uses forward slashes even on Windows, whereas Sillage stores node:path paths; normalize to native format before comparing. */
export function parseWorktreeList(raw: string, platform: NodeJS.Platform = process.platform): WorktreeEntry[] {
  const paths = platform === 'win32' ? win32 : posix
  const entries: WorktreeEntry[] = []
  for (const block of raw.split('\0\0')) {
    const fields = new Map<string, string>()
    for (const field of block.split('\0')) {
      if (!field) continue
      const space = field.indexOf(' ')
      if (space === -1) fields.set(field, '')
      else fields.set(field.slice(0, space), field.slice(space + 1))
    }
    const path = fields.get('worktree')
    if (!path) continue
    entries.push({
      path: paths.normalize(path),
      head: fields.get('HEAD') ?? null,
      branch: fields.get('branch')?.replace(/^refs\/heads\//, '') ?? null,
      main: entries.length === 0,
      prunable: fields.has('prunable'),
    })
  }
  return entries
}

/** Branch used to assess worktrees. `origin/HEAD` identifies the default, but prefer its local counterpart because users merge locally before pushing: `origin/main` would incorrectly mark unpushed merges as pending. Without remotes, try `main` or `master`, then the main worktree's branch. */
export async function defaultBase(repo: string): Promise<string | null> {
  const exists = (ref: string) => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((r) => r.code === 0)

  const remoteHead = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (remoteHead.code === 0) {
    const remote = remoteHead.stdout.trim()
    const local = remote.replace(/^origin\//, '')
    if (await exists(`refs/heads/${local}`)) return local
    if (await exists(`refs/remotes/${remote}`)) return remote
  }
  for (const name of ['main', 'master']) {
    if (await exists(`refs/heads/${name}`)) return name
  }
  const head = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const current = head.stdout.trim()
  return head.code === 0 && current && current !== 'HEAD' ? current : null
}

/** `merge-tree --merge-base` requires git 2.40. Debian 12 and therefore the Docker image use 2.39, as Apple's Command Line Tools have for a long time. Read once per process: versions do not change without restarting. */
let mergeBaseSupport: Promise<boolean> | null = null

function supportsMergeBase(cwd: string): Promise<boolean> {
  mergeBaseSupport ??= git(cwd, ['version']).then(
    (result) => {
      const match = /(\d+)\.(\d+)/.exec(result.stdout)
      if (!match) return false
      const [major, minor] = [Number(match[1]), Number(match[2])]
      return major > 2 || (major === 2 && minor >= 40)
    },
    () => false,
  )
  return mergeBaseSupport
}

export interface WorktreeAssessment {
  /** `assessWorktree` never answers `leftovers`: telling a merge from a fresh tree needs the database (see `status-service.ts`). */
  state: WorktreeState
  ahead: number
  behind: number
  modified: number
  untracked: number
  conflicts: boolean
  lastCommitAt: number | null
  lastEditAt: number | null
  files: WorktreeFileDto[]
  /** Set for `dirty` trees whose commits are all in the base: the candidates for `leftovers`. */
  fingerprint: string | null
  /** Every commit of the branch is already in the base, whatever remains uncommitted. */
  commitsInBase: boolean
  /** Read only for `leftovers` candidates (see `ownCommits`); null otherwise or when unknown. */
  ownCommits: boolean | null
}

const MISSING: WorktreeAssessment = {
  state: 'missing',
  ahead: 0,
  behind: 0,
  modified: 0,
  untracked: 0,
  conflicts: false,
  lastCommitAt: null,
  lastEditAt: null,
  files: [],
  fingerprint: null,
  commitsInBase: false,
  ownCommits: null,
}

/** Tree the base would have after receiving `ref`, and whether merging succeeds. With `mergeBase`, merge a specific delta from `mergeBase` to `ref` rather than full history, allowing stash assessment when its commit has only HEAD as parent. */
async function mergedTree(
  repo: string,
  base: string,
  ref: string,
  mergeBase?: string,
): Promise<{ tree: string; conflicts: boolean } | null> {
  const result = await git(repo, [
    'merge-tree',
    '--write-tree',
    ...(mergeBase ? [`--merge-base=${mergeBase}`] : []),
    base,
    ref,
  ])
  const tree = result.stdout.split('\n')[0]?.trim() ?? ''
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return null
  return { tree, conflicts: result.code !== 0 }
}

interface StatusEntry {
  path: string
  untracked: boolean
  /** Two-letter porcelain code: index then worktree. */
  code: string
}

function fileKind(entry: StatusEntry): WorktreeFileDto['kind'] {
  if (entry.untracked) return 'untracked'
  return entry.code.includes('D') ? 'deleted' : 'modified'
}

function parseStatus(raw: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const code = field.slice(0, 2)
    // Renames occupy two fields: new name followed by old.
    if (code[0] === 'R' || code[0] === 'C') i += 1
    if (code === '!!') continue
    entries.push({ path: field.slice(3), untracked: code === '??', code })
  }
  return entries
}

/** Whether every untracked file already exists identically in the base. Two processes regardless of file count: calculate file hashes and read base blobs, then compare in memory. */
async function untrackedInBase(path: string, base: string, files: string[]): Promise<boolean> {
  if (files.length === 0) return true
  if (files.length > MAX_UNTRACKED_COMPARED) return false

  const [local, known] = await Promise.all([
    git(path, ['hash-object', '--stdin-paths'], files.join('\n') + '\n'),
    git(path, ['cat-file', '--batch-check=%(objectname)'], files.map((f) => `${base}:${f}`).join('\n') + '\n'),
  ])
  if (local.code !== 0 || known.code !== 0) return false

  const ours = local.stdout.split('\n').filter(Boolean)
  const theirs = known.stdout.split('\n').filter(Boolean)
  if (ours.length !== files.length || theirs.length !== files.length) return false
  return ours.every((oid, i) => theirs[i] === oid)
}

/** Most recent modification date among the first listed files. */
async function lastEdit(path: string, files: string[]): Promise<number | null> {
  let latest: number | null = null
  await Promise.all(
    files.slice(0, MAX_FILES_STATTED).map(async (file) => {
      const info = await stat(join(path, file)).catch(() => null)
      if (info && (latest === null || info.mtimeMs > latest)) latest = info.mtimeMs
    }),
  )
  return latest === null ? null : Math.round(latest)
}

/**
 * Identity of the files left in a tree, from metadata only: leftovers include videos and builds
 * that hashing contents on every poll would read in full. Size and modification time change with
 * any write, which is all keeping needs: a touched file shows up again, never the reverse.
 */
async function residueFingerprint(path: string, entries: StatusEntry[]): Promise<string | null> {
  if (entries.length === 0 || entries.length > MAX_FILES_FINGERPRINTED) return null
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const info = await lstat(join(path, entry.path)).catch(() => null)
      return [entry.code, entry.path, info ? `${info.size}:${Math.round(info.mtimeMs)}` : '-'].join('\0')
    }),
  )
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex')
}

/** Commits made on the branch itself, as opposed to moves that only brought in the base. */
const OWN_COMMIT = /^(commit( \((?!merge\))[^)]*\))?|cherry-pick|revert): /

/**
 * Whether the branch received commits of its own, read from its reflog. A fast-forward merge leaves
 * the branch with no commit ahead, exactly like a tree created a minute ago: only the history of
 * the ref tells them apart. Null when the reflog cannot answer: detached HEAD, or entries expired
 * (90 days by default) so that the branch creation is no longer in sight.
 */
async function ownCommits(repo: string, branch: string | null | undefined): Promise<boolean | null> {
  if (!branch) return null
  const result = await git(repo, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--'])
  if (result.code !== 0) return null
  const subjects = result.stdout.split('\n').filter(Boolean)
  if (subjects.some((subject) => OWN_COMMIT.test(subject))) return true
  return subjects.at(-1)?.startsWith('branch: Created') ? false : null
}

/** Assesses worktree commits and modifications absent from the base. `base` is resolved by `defaultBase`. Missing `entry.path` yields `missing`, which takes precedence over all other states. */
export async function assessWorktree(
  repo: string,
  base: string,
  entry: Pick<WorktreeEntry, 'path' | 'head' | 'prunable'> & { branch?: string | null },
  /** Forces the pre-git-2.40 path in tests; otherwise inferred from installed version. */
  options: { legacyGit?: boolean } = {},
): Promise<WorktreeAssessment> {
  if (entry.prunable || !entry.head) return MISSING
  const dir = await stat(entry.path).catch(() => null)
  if (!dir?.isDirectory()) return MISSING

  const [baseTree, counts, lastCommit, status] = await Promise.all([
    line(repo, ['rev-parse', `${base}^{tree}`]),
    line(repo, ['rev-list', '--left-right', '--count', `${base}...${entry.head}`]),
    line(repo, ['log', '-1', '--format=%ct', entry.head]).catch(() => ''),
    out(entry.path, ['status', '--porcelain', '-z', '--untracked-files=all']),
  ])
  const [behind = 0, ahead = 0] = counts.split('\t').map((n) => Number(n) || 0)

  // Commits: is their content already in the base?
  let commitsInBase = ahead === 0
  let conflicts = false
  if (ahead > 0) {
    const merged = await mergedTree(repo, base, entry.head)
    conflicts = merged?.conflicts ?? false
    commitsInBase = merged !== null && !merged.conflicts && merged.tree === baseTree
  }

  // Uncommitted work: `stash create` creates a commit without changing files,
  // then assess its delta against HEAD like a branch.
  const entries = parseStatus(status)
  const tracked = entries.filter((e) => !e.untracked)
  const untracked = entries.filter((e) => e.untracked)
  let trackedInBase = tracked.length === 0
  if (tracked.length > 0) {
    const stash = (await git(entry.path, ['stash', 'create'])).stdout.trim()
    if (stash) {
      const modern = options.legacyGit === undefined ? await supportsMergeBase(repo) : !options.legacyGit
      // Without `--merge-base`, merging stashes also includes branch commits:
      // the result isolates uncommitted work only when those commits are already in the base.
      // Otherwise preserve it as work worth keeping, which at least some of it is,
      // so worktrees are never falsely reported merged.
      const merged = modern
        ? await mergedTree(repo, base, stash, entry.head)
        : commitsInBase
          ? await mergedTree(repo, base, stash)
          : null
      trackedInBase = merged !== null && !merged.conflicts && merged.tree === baseTree
      // Uncommitted work can also conflict: common for abandoned worktrees whose base
      // advanced without them.
      conflicts ||= merged?.conflicts ?? false
    }
  }
  const untrackedKnown = await untrackedInBase(entry.path, base, untracked.map((e) => e.path))

  const state: WorktreeState =
    !trackedInBase || !untrackedKnown ? 'dirty' : !commitsInBase ? 'unmerged' : 'merged'

  const candidate = state === 'dirty' && commitsInBase
  return {
    files: entries.slice(0, MAX_FILES_LISTED).map((e) => ({ path: e.path, kind: fileKind(e) })),
    fingerprint: candidate ? await residueFingerprint(entry.path, entries) : null,
    commitsInBase,
    ownCommits: candidate ? await ownCommits(repo, entry.branch) : null,
    state,
    ahead,
    behind,
    modified: tracked.length,
    untracked: untracked.length,
    conflicts,
    lastCommitAt: lastCommit ? Number(lastCommit) * 1000 : null,
    lastEditAt: await lastEdit(entry.path, entries.map((e) => e.path)),
  }
}
