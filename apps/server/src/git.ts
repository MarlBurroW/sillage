import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { FileState } from '@sillage/protocol'

const run = promisify(execFile)

const GIT_TIMEOUT_MS = 5000

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  return stdout
}

export interface GitStatus {
  branch: string
  isDirty: boolean
}

/** Returns null outside git repositories, a normal case because projects may target arbitrary directories. */
export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return null

    const [branch, porcelain] = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(cwd, ['status', '--porcelain']),
    ])

    return { branch: branch.trim(), isDirty: porcelain.trim().length > 0 }
  } catch {
    return null
  }
}

export async function listBranches(cwd: string): Promise<string[]> {
  const stdout = await git(cwd, ['branch', '--format=%(refname:short)', '--sort=-committerdate'])
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

/** Extracts git errors, far more useful than 'exit code 128'. */
function gitMessage(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr
  const text = stderr?.trim() || (err instanceof Error ? err.message : String(err))
  return text.split('\n').slice(0, 3).join(' ').trim()
}

/** Creates worktrees. `git worktree add` rejects existing branches, so attach them instead of requiring new names: resuming branches is common. */
export async function addWorktree(
  repo: string,
  path: string,
  branch: string,
  baseRef: string,
): Promise<{ reusedBranch: boolean }> {
  const branches = await listBranches(repo).catch((): string[] => [])
  const reusedBranch = branches.includes(branch)

  try {
    await git(
      repo,
      reusedBranch
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', path, '-b', branch, baseRef],
    )
  } catch (err) {
    const message = gitMessage(err)
    // Git says 'already used by worktree': branches can be checked out in only
    // one worktree at a time. Explain clearly to avoid lengthy troubleshooting.
    if (/already (checked out|used by worktree)/i.test(message)) {
      throw new GitError(
        `La branche « ${branch} » est déjà extraite dans un autre worktree ou dans le projet lui-même.`,
      )
    }
    throw new GitError(message)
  }
  return { reusedBranch }
}

export async function removeWorktree(repo: string, path: string, force: boolean): Promise<void> {
  try {
    await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
  } catch (err) {
    throw new GitError(gitMessage(err))
  }
}

/** Consider clones lost after this silence threshold. Use inactivity rather than total duration: multi-gigabyte repositories on slow connections may legitimately take an hour, but five-minute output silence indicates a lost clone. */
const CLONE_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export interface CloneProgress {
  /** Phase as named by Git, such as Receiving objects or Resolving deltas. */
  phase: string
  /** Null until current-phase progress is quantified. */
  percent: number | null
}

/** Translatable clone error. Messages remain English like API errors: interfaces translate codes, while messages provide readable log fallbacks. */
export class CloneError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CloneError'
  }
}

/** Recognizes two actionable git failures: private repositories without valid tokens and nonexistent URLs. Other failures retain raw git text, more precise than paraphrases. */
function cloneFailure(stderr: string): CloneError {
  const text = stderr.trim()

  if (/could not read Username|terminal prompts disabled|Authentication failed/i.test(text)) {
    return new CloneError('clone_auth_failed', 'Authentication failed for this repository.')
  }
  if (/Repository not found|repository '[^']*' does not exist/i.test(text)) {
    return new CloneError('clone_repo_not_found', 'Repository not found.')
  }

  const detail = text.split('\n').filter(Boolean).slice(-3).join(' ').trim()
  return new CloneError('clone_failed', detail || 'git failed without a message.')
}

/** Clones remote repositories. Avoid `git()`'s five-second timeout intended for state reads. Read stderr progress enabled explicitly by `--progress`, which git does not enable automatically without terminals. */
export async function cloneRepository(
  url: string,
  destination: string,
  env: NodeJS.ProcessEnv,
  onProgress: (progress: CloneProgress) => void,
): Promise<void> {
  const child = spawn('git', ['clone', '--progress', '--', url, destination], {
    env: { ...process.env, ...env },
  })

  // Only recent lines help diagnosis, while large clones produce thousands:
  // retaining all would waste memory.
  const tail: string[] = []
  let buffer = ''

  return new Promise<void>((resolve, reject) => {
    let idleTimer: NodeJS.Timeout

    const fail = (error: CloneError) => {
      clearTimeout(idleTimer)
      child.kill('SIGKILL')
      reject(error)
    }

    const resetIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => fail(new CloneError('clone_stalled', 'The clone stopped making progress.')),
        CLONE_IDLE_TIMEOUT_MS,
      )
    }
    resetIdleTimer()

    child.stderr.on('data', (chunk: Buffer) => {
      resetIdleTimer()
      // Git separates phase updates with carriage returns to rewrite lines in place:
      // treat them as line endings.
      buffer += chunk.toString()
      const lines = buffer.split(/[\r\n]/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        tail.push(text)
        if (tail.length > 20) tail.shift()

        const match = /^(.+?):\s+(\d+)%/.exec(text)
        if (match) onProgress({ phase: match[1] ?? '', percent: Number(match[2]) })
        else onProgress({ phase: text, percent: null })
      }
    })

    child.on('error', (err) =>
      fail(new CloneError('clone_failed', `git could not be started: ${err.message}`)),
    )

    child.on('close', (code) => {
      clearTimeout(idleTimer)
      if (code === 0) resolve()
      // Already rejected by `fail` when killed by us; duplicate rejection is ignored.
      else reject(cloneFailure(tail.join('\n')))
    })
  })
}

/** Registers Sillage's credential helper in repository-local configuration. Not global: accounts clone using their own owner IDs, which global configuration cannot represent simultaneously. Worktrees inherit main-repository configuration. Precede with an empty value to clear system/global helpers, especially macOS Keychain, as explained in `credentialEnv`. */
export async function setCredentialHelper(cwd: string, helper: string): Promise<void> {
  await git(cwd, ['config', '--local', '--replace-all', 'credential.helper', ''])
  await git(cwd, ['config', '--local', '--add', 'credential.helper', helper])
}

/** Local credential helpers in git query order. Null outside repositories or without local helpers. */
export async function readLocalCredentialHelpers(cwd: string): Promise<string[] | null> {
  try {
    // `-z` terminates values with null bytes, preserving the initial empty value.
    const raw = await git(cwd, ['config', '--local', '-z', '--get-all', 'credential.helper'])
    return raw.split('\0').slice(0, -1)
  } catch {
    return null
  }
}

/** Replaces all local helpers including order. Clear and rewrite rather than `--replace-all` with patterns: only this preserves every value's position. */
export async function writeLocalCredentialHelpers(cwd: string, helpers: string[]): Promise<void> {
  await git(cwd, ['config', '--local', '--unset-all', 'credential.helper'])
  for (const helper of helpers) {
    await git(cwd, ['config', '--local', '--add', 'credential.helper', helper])
  }
}

/** All repository file statuses in one call. Reduce `--porcelain` codes to tree-display states: distinguishing simultaneous index and working-tree changes adds nothing to file lists. Per-file calls would be costly in large directories, and explorers expand one level at a time. `-z` preserves filenames containing spaces or quotes. Null outside repositories because projects may target arbitrary directories. */
export async function readFileStates(cwd: string): Promise<Map<string, FileState> | null> {
  let raw: string
  try {
    const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return null
    raw = await git(cwd, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
    ])
  } catch {
    return null
  }

  const states = new Map<string, FileState>()
  const fields = raw.split('\0')

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field || field.length < 4) continue

    const code = field.slice(0, 2)
    let path = field.slice(3)

    // Renames occupy two fields, new name then old. The
    // new name existing on disk, so consume and ignore the next field.
    if (code[0] === 'R' || code[0] === 'C') i += 1

    // Git reports fully ignored directories as single entries with trailing
    // separators: remove separators to match actual entries.
    if (path.endsWith('/')) path = path.slice(0, -1)

    if (code === '!!') states.set(path, 'ignored')
    else if (code === '??') states.set(path, 'untracked')
    else if (code.includes('D')) states.set(path, 'deleted')
    else if (code.includes('A') || code[0] === 'R' || code[0] === 'C') states.set(path, 'added')
    else states.set(path, 'modified')
  }

  return states
}

export interface Commit {
  parents: string[]
  hash: string
  shortHash: string
  subject: string
  author: string
  ts: number
  refs: string[]
}

/** Commit references from `%D`: 'HEAD -> main, origin/main, tag: v1'. Remove HEAD arrows because current commits are indicated separately. */
function parseRefs(decoration: string | undefined): string[] {
  if (!decoration) return []
  return decoration
    .split(', ')
    .map((ref) => ref.replace(/^HEAD -> /, '').trim())
    .filter((ref) => ref.length > 0 && ref !== 'HEAD')
}

/** Topological history: children precede parents even when timestamps disagree. Read one extra commit without returning it to detect more history without counting everything. Null outside repositories; empty lists before the first commit because `git log` failing without HEAD is normal state. */
export async function readCommits(
  cwd: string,
  limit: number,
  skip: number,
  all = false,
): Promise<{ commits: Commit[]; hasMore: boolean } | null> {
  try {
    if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return null
  } catch {
    return null
  }
  const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
  if (!all && !hasHead) return { commits: [], hasMore: false }

  // Explicit refs exclude technical stash and checkpoint commits.
  const raw = await git(cwd, [
    'log',
    '--topo-order',
    ...(all ? ['--branches', '--remotes', '--tags', ...(hasHead ? ['HEAD'] : [])] : []),
    `--max-count=${limit + 1}`,
    `--skip=${skip}`,
    '--format=%H%x00%h%x00%s%x00%an%x00%ct%x00%D%x00%P',
  ])

  const commits = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash, shortHash, subject, author, ts, decoration, parents] = line.split('\0')
      return {
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        subject: subject ?? '',
        author: author ?? '',
        ts: Number(ts) * 1000 || 0,
        refs: parseRefs(decoration),
        parents: parents?.split(' ').filter(Boolean) ?? [],
      }
    })
    .filter((commit) => commit.hash.length > 0)

  return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
}

export interface DiffFile {
  path: string
  added: number
  removed: number
}

export interface WorkingDiff {
  files: DiffFile[]
  /** Full unified diff truncated beyond `MAX_DIFF_BYTES`. */
  patch: string
  truncated: boolean
}

/** Multi-megabyte diffs are neither useful to display nor transfer. */
const MAX_DIFF_BYTES = 512 * 1024

/** Splits `--numstat` output into files. Binary files use '-' instead of counts. */
function parseNumstat(numstat: string): DiffFile[] {
  return numstat
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split('\t')
      return { path: path ?? '', added: Number(added) || 0, removed: Number(removed) || 0 }
    })
    .filter((file) => file.path.length > 0)
}

/** Commit changes against the first parent. `-m --first-parent` shows what merges contribute to branches instead of `git show`'s default empty result. */
export async function readCommitDiff(cwd: string, hash: string): Promise<WorkingDiff> {
  try {
    const [numstat, patch] = await Promise.all([
      git(cwd, ['show', '--format=', '--numstat', '-m', '--first-parent', hash]),
      git(cwd, ['show', '--format=', '--patch', '-m', '--first-parent', hash]),
    ])

    const truncated = Buffer.byteLength(patch) > MAX_DIFF_BYTES
    return {
      files: parseNumstat(numstat),
      patch: truncated ? patch.slice(0, MAX_DIFF_BYTES) : patch,
      truncated,
    }
  } catch (err) {
    throw new GitError(gitMessage(err))
  }
}
