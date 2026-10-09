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

/**
 * Le workflow git de l'onglet Git : état détaillé du dépôt, puis les gestes dessus.
 *
 * Deux portées, conversation et projet, comme le reste du panneau (voir
 * `workspace-scopes.ts`). Les droits sont ceux du panneau : qui voit le projet agit
 * sur son dépôt, comme il le ferait déjà depuis un terminal du panneau.
 *
 * Les actions d'un même dépôt sont sérialisées : git refuse de travailler à deux, et
 * un double clic ne doit pas finir en « index.lock exists ».
 */
export function registerGitActionRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Le helper de credentials de Sillage, pour les commandes qui parlent au remote.
   * Introuvable sur une installation incomplète : on s'en passe plutôt que d'interdire
   * un push qui passerait par les credentials du dépôt lui-même.
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
     * Une action sur le dépôt de la portée : résolution du répertoire, sérialisation,
     * traduction des erreurs. Le corps de chaque route ne dit plus que le geste.
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

    // Dépôt
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
 * Codes qui décrivent un état du dépôt plutôt qu'une requête fautive : l'interface y
 * répond par un remède (forcer, stasher, choisir rebase ou merge), d'où le 409.
 */
const STATE_CODES = new Set([
  'git_index_locked',
  'git_dirty_worktree',
  'git_branch_unmerged',
  'git_pull_diverged',
  'git_push_rejected',
  'git_unmerged_paths',
])

/** Les erreurs de git sortent avec leur code et le texte de git en paramètre. */
async function guard<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (err) {
    if (err instanceof HttpError) throw err
    // Les corps sont validés dans l'action, donc ici : un refus de validation doit rester
    // `validation_failed`, pas devenir un échec de git.
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
