import { z } from 'zod'
import { commitHashSchema } from './api.js'

/**
 * Panel git workflow: index, commits, branches, remotes, stashes.
 *
 * Unlike `api.ts` reads (working diff, commits), which only display information, this acts on
 * the repository. Request-body schemas are strict because every value ends up on git's command
 * line, where a name starting with `-` becomes an option.
 */

/** Change kind from the XY column of `git status --porcelain=v2`. */
export const gitChangeKindSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted',
])
export type GitChangeKind = z.infer<typeof gitChangeKindSchema>

export interface GitChangeDto {
  path: string
  /** Original path of a rename or copy; otherwise null. */
  oldPath: string | null
  kind: GitChangeKind
  /** Added and removed lines. Null for binaries or when git does not count them. */
  added: number | null
  removed: number | null
}

/** Unfinished multi-step operation: git waits for completion or abort. */
export const gitOperationSchema = z.enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'])
export type GitOperation = z.infer<typeof gitOperationSchema>

export interface GitRepoStatusDto {
  /** Current branch; null for detached HEAD. */
  branch: string | null
  /** True when HEAD points to no branch. */
  detached: boolean
  /** True when the repository has no commits: no HEAD to compare against. */
  unborn: boolean
  head: { hash: string; shortHash: string; subject: string; body: string } | null
  /** Tracked remote branch (`origin/main`); null without an upstream. */
  upstream: string | null
  ahead: number
  behind: number
  operation: GitOperation | null
  remotes: string[]
  /** In the index, ready to commit. */
  staged: GitChangeDto[]
  /** Only in the working directory, including untracked files. */
  unstaged: GitChangeDto[]
  /** Conflicted: resolve, then mark resolved by staging. */
  conflicted: GitChangeDto[]
  stashCount: number
}

export interface GitStatusDto {
  cwd: string
  /** Null outside a git repository: a project may point to any directory. */
  repo: GitRepoStatusDto | null
}

export interface GitBranchDto {
  name: string
  current: boolean
  hash: string
  subject: string
  /** Latest commit timestamp in milliseconds. */
  ts: number
  upstream: string | null
  ahead: number
  behind: number
  /** True if the tracked remote branch has disappeared. */
  gone: boolean
  /** Worktree path where the branch is checked out; null if nowhere. */
  worktreePath: string | null
}

export interface GitRemoteBranchDto {
  /** Full name, `origin/main`. */
  name: string
  remote: string
  hash: string
  subject: string
  ts: number
}

export interface GitBranchesDto {
  local: GitBranchDto[]
  remote: GitRemoteBranchDto[]
}

export interface GitStashDto {
  index: number
  message: string
  /** Branch where the stash was created, as recorded by git in its message. */
  branch: string | null
  ts: number
}

export interface GitStashListDto {
  stashes: GitStashDto[]
}

export interface GitFileDiffDto {
  patch: string
  truncated: boolean
}

/**
 * Result of an action git considers successful, including conflicts: a merge leaving conflicts
 * is not a failure, but the normal state before resolution.
 */
export interface GitActionDto {
  /** Useful git output, one line (“Already up to date.”), or null. */
  summary: string | null
  /** True when the action leaves working-directory conflicts to resolve. */
  conflicts: boolean
}

export interface GitCommitResultDto extends GitActionDto {
  hash: string
  shortHash: string
}

// Request bodies

/**
 * Repository-relative path as returned by `git status`. Git enforces repository containment by
 * rejecting external pathspecs; null bytes cannot appear on a command line.
 */
const gitPathSchema = z.string().min(1).max(4096).refine((path) => !path.includes('\0'))

/** Absent means the entire working directory. */
export const gitPathsBodySchema = z.object({
  paths: z.array(gitPathSchema).min(1).max(5000).optional(),
})

/** These paths are required: discarding “everything” must be an intentional selection of each entry. */
export const gitDiscardBodySchema = z.object({
  paths: z.array(gitPathSchema).min(1).max(5000),
})

export const gitAreaSchema = z.enum(['staged', 'unstaged', 'untracked'])
export type GitArea = z.infer<typeof gitAreaSchema>

export const gitFileDiffQuerySchema = z.object({
  path: gitPathSchema,
  area: gitAreaSchema,
})

export const gitCommitBodySchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  amend: z.boolean().default(false),
  /** Stage the whole working directory first: one-step “commit all”. */
  stageAll: z.boolean().default(false),
})

/**
 * A git reference name, excluding anything resembling an option or range (`-x`, `a..b`,
 * `@{1}`). Git's rules are richer; additional violations fail there with a clear message.
 */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:?*[\\]+$/, 'Nom de référence invalide')
  .refine((ref) => !ref.startsWith('-'), 'Un nom ne peut pas commencer par un tiret')
  .refine(
    (ref) => !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.lock'),
    'Nom de référence invalide',
  )
  .refine(
    (ref) => !ref.startsWith('/') && !ref.endsWith('/') && !ref.includes('//'),
    'Nom de référence invalide',
  )

export const gitCreateBranchBodySchema = z.object({
  name: gitRefSchema,
  /** Starting point: branch or commit. Defaults to HEAD. */
  from: z.union([gitRefSchema, commitHashSchema]).optional(),
  checkout: z.boolean().default(true),
})

export const gitCheckoutBodySchema = z.object({
  /** A local branch, remote branch (`origin/x`) or commit. */
  ref: z.union([gitRefSchema, commitHashSchema]),
})

export const gitDeleteBranchBodySchema = z.object({
  name: gitRefSchema,
  /** `-D`: delete the branch even if unmerged. Never implicit. */
  force: z.boolean().default(false),
})

export const gitMergeBodySchema = z.object({
  ref: z.union([gitRefSchema, commitHashSchema]),
})

export const gitPullBodySchema = z.object({
  /** Absent follows `pull.rebase`; otherwise forces the strategy. */
  rebase: z.boolean().optional(),
})

export const gitPushBodySchema = z.object({
  /** `--force-with-lease`, not `--force`: refuses to overwrite unseen changes. */
  force: z.boolean().default(false),
  /** Publication remote when the branch has no upstream yet. Otherwise `origin`. */
  remote: gitRefSchema.optional(),
})

export const gitStashBodySchema = z.object({
  message: z.string().trim().max(500).optional(),
  includeUntracked: z.boolean().default(true),
})

export const gitStashIndexBodySchema = z.object({
  index: z.number().int().min(0).max(10_000),
})

export const gitResetModeSchema = z.enum(['soft', 'mixed', 'hard'])
export type GitResetMode = z.infer<typeof gitResetModeSchema>

export const gitResetBodySchema = z.object({
  hash: commitHashSchema,
  mode: gitResetModeSchema,
})

export const gitRevertBodySchema = z.object({
  hash: commitHashSchema,
})

// Turn checkpoints

export const checkpointKeySchema = z.string().regex(/^[0-9a-f-]{8,64}$/)

export const checkpointFileDiffQuerySchema = z.object({
  path: gitPathSchema,
  /** Previous name in a rename: without it, git would show a creation. */
  oldPath: gitPathSchema.optional(),
})

export interface CheckpointRestoreDto {
  written: number
  deleted: number
  /** False when the index could not be captured due to conflicts during the turn. */
  indexRestored: boolean
}
