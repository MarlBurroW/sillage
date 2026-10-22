import type { FastifyInstance } from 'fastify'
import {
  commitHashSchema,
  commitListQuerySchema,
  type CommitDiffDto,
  type CommitListDto,
} from '@sillage/protocol'
import { readCommitDiff, readCommits } from '../../git.js'
import type { AppContext } from '../context.js'
import { badRequest } from '../errors.js'
import { requireUser } from '../require-user.js'
import { workspaceScopes } from './workspace-scopes.js'

/** Git reads for the panel Git tab: commits and their changes. Working-directory state lives alongside its operations in `git-actions.ts`. Extracted from `conversations.ts` because these reads depend only on a directory, not a conversation, and also serve the project workspace view. Computed on demand rather than journaled because this is current disk state, not an event. */
export function registerGitViewRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Conversation and project scopes: see `workspace-scopes.ts`.
  for (const { base, cwdOf } of workspaceScopes) {
    /** History of the current branch, or all branches for the graph. Paginated rather than capped: repositories contain thousands of commits; show recent ones with the option to load older history. */
    app.get(`${base}/commits`, async (request): Promise<CommitListDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { limit, skip, all } = commitListQuerySchema.parse(request.query)

      try {
        const result = await readCommits(cwdOf(ctx.db, id, user.id), limit, skip, all)
        return { commits: result?.commits ?? null, hasMore: result?.hasMore ?? false }
      } catch (err) {
        throw badRequest('git_failed', err instanceof Error ? err.message : String(err))
      }
    })

    /** Changes made by a commit. Read on demand because each diff spawns git. */
    app.get(`${base}/commits/:hash/diff`, async (request): Promise<CommitDiffDto> => {
      const user = requireUser(request)
      const { id, hash } = request.params as { id: string; hash: string }
      const cwd = cwdOf(ctx.db, id, user.id)

      const parsed = commitHashSchema.safeParse(hash)
      if (!parsed.success) throw badRequest('bad_commit', 'This is not a commit hash.')

      try {
        return await readCommitDiff(cwd, parsed.data)
      } catch (err) {
        throw badRequest('git_failed', err instanceof Error ? err.message : String(err))
      }
    })
  }
}
