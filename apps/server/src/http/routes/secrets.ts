import type { FastifyInstance } from 'fastify'
import { mcpServers } from '@sillage/db'
import { putSecretBodySchema, secretNameSchema, type SecretListDto } from '@sillage/protocol'
import { secretsUsedBy } from '../../agents/mcp-registry.js'
import type { SecretStore } from '../../secrets/store.js'
import type { AppContext } from '../context.js'
import { notFound } from '../errors.js'
import { requireAdmin } from '../require-user.js'

/**
 * Dépôt de secrets de l'instance.
 *
 * Administrateurs seuls, y compris en lecture : même sans les valeurs, la liste des
 * noms décrit ce à quoi cette instance a accès, et n'a pas à être publique.
 *
 * Aucune route ne rend la valeur d'un secret. Corriger une faute de frappe se fait
 * donc en réécrivant le secret entier, ce qui est le prix à payer pour qu'un jeton ne
 * puisse pas repartir vers un navigateur.
 */
export function registerSecretRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  secrets: SecretStore,
): void {
  /**
   * Où chaque secret est employé.
   *
   * Calculé à la lecture plutôt que tenu à jour : le registre MCP est petit, et un
   * index dénormalisé se serait désynchronisé au premier serveur modifié.
   */
  const usage = (): Map<string, string[]> => {
    const bySecret = new Map<string, string[]>()
    for (const row of ctx.db.select().from(mcpServers).all()) {
      for (const name of secretsUsedBy(row)) {
        bySecret.set(name, [...(bySecret.get(name) ?? []), row.name])
      }
    }
    return bySecret
  }

  app.get('/api/secrets', async (request): Promise<SecretListDto> => {
    requireAdmin(request)
    const usedBy = usage()
    return {
      secrets: secrets.list().map((secret) => ({
        ...secret,
        usedBy: usedBy.get(secret.name) ?? [],
      })),
    }
  })

  /**
   * `PUT` et non `POST` : écrire un secret est idempotent, et remplacer une valeur est
   * le geste courant, pas l'exception. Un `POST` aurait imposé de distinguer la
   * création de la mise à jour alors que rien ici ne les différencie.
   */
  app.put('/api/secrets', async (request, reply) => {
    requireAdmin(request)
    const body = putSecretBodySchema.parse(request.body)
    secrets.put(body.name, body.value)
    reply.status(204)
  })

  app.delete('/api/secrets/:name', async (request, reply) => {
    requireAdmin(request)
    const { name } = request.params as { name: string }
    // Validé avant d'atteindre la base : le nom vient de l'URL, et un motif refusé à
    // l'écriture n'a pas de raison d'être accepté à la suppression.
    if (!secrets.delete(secretNameSchema.parse(name))) {
      throw notFound('secret_not_found', 'Unknown secret.')
    }
    reply.status(204)
  })
}
