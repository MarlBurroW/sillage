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
 * Accès aux forges git de l'utilisateur courant.
 *
 * Par compte et non par instance, contrairement aux secrets : cloner un dépôt privé est
 * un geste d'utilisateur. Chacun ne voit et ne modifie donc que ses propres credentials,
 * y compris un administrateur, qui n'a aucune raison d'emprunter le jeton d'un autre.
 *
 * Aucune route ne rend un jeton. Corriger une faute de frappe se fait en le réécrivant,
 * comme pour les secrets.
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
   * `PUT` et non `POST` : écrire un jeton est idempotent, et le remplacer quand il
   * expire est le geste courant, pas l'exception.
   */
  app.put('/api/git-credentials', async (request, reply) => {
    const user = requireUser(request)
    const body = putGitCredentialBodySchema.parse(request.body)

    credentials.put(user.id, body.host, body.username, body.token)
    // Le catalogue en cache a été constitué avec le jeton précédent, qui ne donnait
    // peut-être pas accès aux mêmes dépôts.
    catalog.forget(user.id)

    reply.status(204)
  })

  app.delete('/api/git-credentials/:host', async (request, reply) => {
    const user = requireUser(request)
    const { host } = request.params as { host: string }

    // Validé avant d'atteindre la base : l'hôte vient de l'URL, et un motif refusé à
    // l'écriture n'a pas de raison d'être accepté à la suppression.
    if (!credentials.delete(user.id, gitHostSchema.parse(host))) {
      throw notFound('git_credential_not_found', 'No credential for this host.')
    }
    catalog.forget(user.id)

    reply.status(204)
  })

  /**
   * Dépôts accessibles avec le jeton, pour la combobox de création de projet.
   *
   * GitHub seul pour l'instant : chaque forge a sa propre API de listage, et rien dans
   * l'interface ne dépend de cette route, qui n'est qu'un raccourci. Coller une URL
   * reste la voie universelle.
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
      // Un jeton refusé ou un quota épuisé n'est pas une panne de Sillage : le code
      // distingue les cas, pour que l'interface dise quoi corriger.
      if (err instanceof GitHubError) {
        throw new HttpError(502, err.code, err.message, err.params)
      }
      throw err
    }
  })
}
