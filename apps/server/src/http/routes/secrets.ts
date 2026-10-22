import type { FastifyInstance } from 'fastify'
import { mcpServers } from '@sillage/db'
import { putSecretBodySchema, secretNameSchema, type SecretListDto } from '@sillage/protocol'
import { secretsUsedBy } from '../../agents/mcp-registry.js'
import type { SecretStore } from '../../secrets/store.js'
import type { AppContext } from '../context.js'
import { notFound } from '../errors.js'
import { requireAdmin } from '../require-user.js'

/**
 * Instance secret store.
 *
 * Administrators only, including reads: even names reveal the resources this
 * instance can access and need not be public.
 *
 * No route returns secret values. Fixing a typo therefore means replacing the
 * entire secret, the price of ensuring tokens never travel back to browsers.
 */
export function registerSecretRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  secrets: SecretStore,
): void {
  /**
   * Where each secret is used.
   *
   * Computed on read: the MCP registry is small, and a denormalized index would
   * fall out of sync as soon as a server was modified.
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
   * `PUT` rather than `POST`: writing a secret is idempotent, and replacement is
   * the common operation. `POST` would require distinguishing creation from
   * updating when nothing here makes that distinction.
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
    // Validate before reaching the database: the name comes from the URL, and a
    // pattern rejected on writes has no reason to be accepted on deletion.
    if (!secrets.delete(secretNameSchema.parse(name))) {
      throw notFound('secret_not_found', 'Unknown secret.')
    }
    reply.status(204)
  })
}
