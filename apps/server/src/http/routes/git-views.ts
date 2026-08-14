import type { FastifyInstance } from 'fastify'
import {
  commitHashSchema,
  commitListQuerySchema,
  type CommitDiffDto,
  type CommitListDto,
  type WorkingDiffDto,
} from '@sillage/protocol'
import {
  readCommitDiff,
  readCommits,
  readGitStatus,
  readHeadCommit,
  readWorkingDiff,
} from '../../git.js'
import type { AppContext } from '../context.js'
import { badRequest } from '../errors.js'
import { requireUser } from '../require-user.js'
import { workspaceScopes } from './workspace-scopes.js'

/**
 * Lectures git de l'onglet Git du panneau : diff courant et commits.
 *
 * Sorties de `conversations.ts` parce qu'elles n'ont rien de propre à un fil : elles ne
 * regardent qu'un répertoire, et existent donc aussi par projet, où le panneau montre
 * l'état du workspace. Calculées à la demande plutôt que journalisées : c'est un état
 * courant du disque, pas un événement.
 */
export function registerGitViewRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Deux portées, conversation et projet : voir `workspace-scopes.ts`.
  for (const { base, cwdOf } of workspaceScopes) {
    app.get(`${base}/diff`, async (request): Promise<WorkingDiffDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }

      const cwd = cwdOf(ctx.db, id, user.id)
      try {
        // Les trois lectures partent ensemble : elles lancent chacune un process git, et
        // les enchaîner triplerait le temps d'ouverture de l'onglet.
        const [diff, status, head] = await Promise.all([
          readWorkingDiff(cwd),
          readGitStatus(cwd),
          readHeadCommit(cwd),
        ])
        return {
          files: diff?.files ?? null,
          patch: diff?.patch ?? '',
          truncated: diff?.truncated ?? false,
          cwd,
          branch: status?.branch ?? null,
          head,
        }
      } catch (err) {
        throw badRequest('git_failed', err instanceof Error ? err.message : String(err))
      }
    })

    /**
     * Commits de la branche du répertoire consulté.
     *
     * Paginé plutôt que plafonné : un dépôt a des milliers de commits, et l'onglet en
     * montre les derniers, avec de quoi remonter plus loin à la demande.
     */
    app.get(`${base}/commits`, async (request): Promise<CommitListDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { limit, skip } = commitListQuerySchema.parse(request.query)

      try {
        const result = await readCommits(cwdOf(ctx.db, id, user.id), limit, skip)
        return { commits: result?.commits ?? null, hasMore: result?.hasMore ?? false }
      } catch (err) {
        throw badRequest('git_failed', err instanceof Error ? err.message : String(err))
      }
    })

    /** Ce qu'un commit a changé. Lu à la demande : un diff par commit coûte un process git. */
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
