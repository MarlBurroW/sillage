import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import {
  gitCheckoutBodySchema,
  gitCommitBodySchema,
  gitCreateBranchBodySchema,
  gitDeleteBranchBodySchema,
  gitDiscardBodySchema,
  gitFileDiffQuerySchema,
  gitMergeBodySchema,
  gitPathsBodySchema,
  gitPullBodySchema,
  gitPushBodySchema,
  gitResetBodySchema,
  gitRevertBodySchema,
  gitStashBodySchema,
  gitStashIndexBodySchema,
  type GitBranchesDto,
  type GitFileDiffDto,
  type GitStashListDto,
  type GitStatusDto,
} from '@sillage/protocol'
import { credentialHelperCommand } from '../../git-credential/helper.js'
import {
  GitActionError,
  abortOperation,
  checkout,
  commit,
  continueOperation,
  createBranch,
  deleteBranch,
  discard,
  fetch,
  initRepository,
  merge,
  networkEnv,
  pull,
  push,
  readBranches,
  readFileDiff,
  readRepoStatus,
  readStashes,
  resetTo,
  revertCommit,
  serialized,
  stage,
  stashApply,
  stashDrop,
  stashPush,
  unstage,
} from '../../git-workflow.js'
import type { AppContext } from '../context.js'
import { HttpError, badRequest, conflict } from '../errors.js'
import { requireUser } from '../require-user.js'
import { workspaceScopes } from './workspace-scopes.js'
import type { WorktreeStatusService } from '../../worktrees/status-service.js'

/**
 * Git tab workflow: detailed repository state and operations on it.
 *
 * Conversation and project scopes match the rest of the panel (see
 * `workspace-scopes.ts`). Panel permissions apply: project viewers may act on
 * its repository, just as they can through a panel terminal.
 *
 * Serialize operations per repository: git cannot run competing writes, and
 * double clicks must not end in 'index.lock exists'.
 */
export function registerGitActionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  worktreeStatus: WorktreeStatusService,
): void {
  /**
   * Sillage credential helper for commands communicating with remotes.
   * Missing in incomplete installations: proceed without it rather than block
   * pushes that could use the repository's own credentials.
   */
  const remoteEnv = (userId: string): NodeJS.ProcessEnv => {
    try {
      return networkEnv(credentialHelperCommand(ctx.config.paths, userId))
    } catch {
      return networkEnv(null)
    }
  }

  for (const { base, cwdOf } of workspaceScopes) {
    app.get(`${base}/git/status`, async (request): Promise<GitStatusDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const cwd = cwdOf(ctx.db, id, user.id)
      return { cwd, repo: await guard(() => readRepoStatus(cwd)) }
    })

    app.get(`${base}/git/file-diff`, async (request): Promise<GitFileDiffDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { path, area } = gitFileDiffQuerySchema.parse(request.query)
      const cwd = cwdOf(ctx.db, id, user.id)
      return guard(() => readFileDiff(cwd, path, area))
    })

    app.get(`${base}/git/branches`, async (request): Promise<GitBranchesDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      return guard(() => readBranches(cwdOf(ctx.db, id, user.id)))
    })

    app.get(`${base}/git/stashes`, async (request): Promise<GitStashListDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      return { stashes: await guard(() => readStashes(cwdOf(ctx.db, id, user.id))) }
    })

    /**
     * Scoped repository operation: resolve its directory, serialize operations
     * and translate errors. Route bodies then express only the operation itself.
     */
    const action = <T>(
      path: string,
      handler: (cwd: string, body: unknown, userId: string) => Promise<T>,
      options: { method?: 'POST' | 'DELETE'; status?: number } = {},
    ) => {
      app.route({
        method: options.method ?? 'POST',
        url: `${base}/git/${path}`,
        handler: async (request, reply) => {
          const user = requireUser(request)
          const { id } = request.params as { id: string }
          const cwd = cwdOf(ctx.db, id, user.id)
          const result = await guard(() =>
            serialized(cwd, () => handler(cwd, request.body, user.id)),
          )
          // Commits, merges and branches may change worktree progress.
          worktreeStatus.invalidateForCwd(cwd)
          if (result === undefined) return reply.status(options.status ?? 204).send()
          return result
        },
      })
    }

    // Index
    action('stage', (cwd, body) => stage(cwd, gitPathsBodySchema.parse(body ?? {}).paths))
    action('unstage', (cwd, body) => unstage(cwd, gitPathsBodySchema.parse(body ?? {}).paths))
    action('discard', (cwd, body) => discard(cwd, gitDiscardBodySchema.parse(body).paths))
    action('commit', (cwd, body) => {
      const { message, amend, stageAll } = gitCommitBodySchema.parse(body)
      return commit(cwd, message, { amend, stageAll })
    })

    // Branches
    action('branches', (cwd, body) => {
      const { name, from, checkout: switchTo } = gitCreateBranchBodySchema.parse(body)
      return createBranch(cwd, name, from, switchTo)
    })
    action('checkout', (cwd, body) => checkout(cwd, gitCheckoutBodySchema.parse(body).ref))
    action(
      'branches',
      (cwd, body) => {
        const { name, force } = gitDeleteBranchBodySchema.parse(body)
        return deleteBranch(cwd, name, force)
      },
      { method: 'DELETE' },
    )
    action('merge', (cwd, body) => merge(cwd, gitMergeBodySchema.parse(body).ref))
    action('abort', (cwd) => abortOperation(cwd))
    action('continue', (cwd) => continueOperation(cwd))

    // Remote
    action('fetch', (cwd, _body, userId) => fetch(cwd, remoteEnv(userId)))
    action('pull', (cwd, body, userId) =>
      pull(cwd, gitPullBodySchema.parse(body ?? {}).rebase, remoteEnv(userId)),
    )
    action('push', (cwd, body, userId) => {
      const { force, remote } = gitPushBodySchema.parse(body ?? {})
      return push(cwd, { force, remote }, remoteEnv(userId))
    })

    // Stash
    action('stash', (cwd, body) => {
      const { message, includeUntracked } = gitStashBodySchema.parse(body ?? {})
      return stashPush(cwd, message || undefined, includeUntracked)
    })
    action('stash/apply', (cwd, body) =>
      stashApply(cwd, gitStashIndexBodySchema.parse(body).index, false),
    )
    action('stash/pop', (cwd, body) => stashApply(cwd, gitStashIndexBodySchema.parse(body).index, true))
    action('stash/drop', (cwd, body) => stashDrop(cwd, gitStashIndexBodySchema.parse(body).index))

    // Repository
    action('init', (cwd) => initRepository(cwd))

    // Commits
    action('revert', (cwd, body) => revertCommit(cwd, gitRevertBodySchema.parse(body).hash))
    action('reset', (cwd, body) => {
      const { hash, mode } = gitResetBodySchema.parse(body)
      return resetTo(cwd, hash, mode)
    })
  }
}

/**
 * Codes describing repository state rather than invalid requests: the interface
 * offers remedies (force, stash, choose rebase or merge), hence status 409.
 */
const STATE_CODES = new Set([
  'git_index_locked',
  'git_dirty_worktree',
  'git_branch_unmerged',
  'git_pull_diverged',
  'git_push_rejected',
  'git_unmerged_paths',
])

/** Git errors retain their code with git's text passed as a parameter. */
async function guard<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (err) {
    if (err instanceof HttpError) throw err
    // Bodies are validated inside the action here: validation failures must remain
    // `validation_failed` rather than become git failures.
    if (err instanceof ZodError) throw err
    if (err instanceof GitActionError) {
      const make = STATE_CODES.has(err.code) ? conflict : badRequest
      throw make(err.code, err.detail, { detail: err.detail })
    }
    throw badRequest('git_failed', err instanceof Error ? err.message : String(err), {
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}
