import type { FastifyInstance } from 'fastify'
import {
  gitHostSchema,
  putGitCredentialBodySchema,
  type GitCredentialListDto,
  type GitRepoListDto,
} from '@sillage/protocol'
import { GITHUB_HOST, GitHubError, type GitHubRepoCatalog } from '../../git-credentials/github.js'
import type { GitCredentialStore } from '../../git-credentials/store.js'
import { HttpError, badRequest, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Current user's git forge access.
 *
 * Per account rather than instance, unlike secrets: cloning private repositories
 * is a user action. Everyone sees and edits only their own credentials, including
 * administrators, who have no reason to borrow another user's token.
 *
 * No route returns tokens. Correcting typos requires replacing them, as with secrets.
 */
export function registerGitCredentialRoutes(
  app: FastifyInstance,
  credentials: GitCredentialStore,
  catalog: GitHubRepoCatalog,
): void {
  app.get('/api/git-credentials', async (request): Promise<GitCredentialListDto> => {
    const user = requireUser(request)
    return { credentials: credentials.list(user.id) }
  })

  /**
   * `PUT` rather than `POST`: token writes are idempotent, and replacing expired
   * tokens is the ordinary operation rather than an exception.
   */
  app.put('/api/git-credentials', async (request, reply) => {
    const user = requireUser(request)
    const body = putGitCredentialBodySchema.parse(request.body)

    credentials.put(user.id, body.host, body.username, body.token)
    // The cached catalog used the previous token, which may have granted access
    // to a different set of repositories.
    catalog.forget(user.id)

    reply.status(204)
  })

  app.delete('/api/git-credentials/:host', async (request, reply) => {
    const user = requireUser(request)
    const { host } = request.params as { host: string }

    // Validate before reaching the database: the host comes from the URL, and a
    // pattern rejected on writes has no reason to be accepted on deletion.
    if (!credentials.delete(user.id, gitHostSchema.parse(host))) {
      throw notFound('git_credential_not_found', 'No credential for this host.')
    }
    catalog.forget(user.id)

    reply.status(204)
  })

  /**
   * Repositories accessible with the token, for the project creation combobox.
   *
   * GitHub only for now: every forge has its own listing API, and the interface
   * does not depend on this shortcut. Pasting a URL remains universal.
   */
  app.get('/api/git-credentials/:host/repos', async (request): Promise<GitRepoListDto> => {
    const user = requireUser(request)
    const { host } = request.params as { host: string }
    const { q } = request.query as { q?: string }

    if (gitHostSchema.parse(host) !== GITHUB_HOST) {
      throw badRequest(
        'git_repo_listing_unsupported',
        'Repository listing is only available for {host}.',
        { host: GITHUB_HOST },
      )
    }

    const credential = credentials.resolve(user.id, GITHUB_HOST)
    if (!credential) {
      throw notFound('git_credential_not_found', 'No credential for this host.')
    }

    try {
      return await catalog.search(user.id, credential.token, q ?? '')
    } catch (err) {
      // A rejected token or exhausted quota is not a Sillage failure: distinct codes
      // let the interface explain what needs correcting.
      if (err instanceof GitHubError) {
        throw new HttpError(502, err.code, err.message, err.params)
      }
      throw err
    }
  })
}
