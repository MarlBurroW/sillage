import type { FastifyInstance } from 'fastify'
import { connectOpencodeKeyBodySchema, type OpencodeProviderListDto } from '@sillage/protocol'
import { OpencodeProvidersUnsupported, type OpencodeProviders } from '../../agents/opencode/providers.js'
import { HttpError } from '../errors.js'
import { requireAdmin } from '../require-user.js'

/**
 * OpenCode model providers. A connection serves every conversation on the machine, so the three
 * routes belong to administrators (scope rule: global). The key goes through once, to OpenCode;
 * nothing returned here carries one.
 */
export function registerOpencodeProviderRoutes(app: FastifyInstance, providers: Pick<OpencodeProviders, 'list' | 'connectKey' | 'disconnect'>): void {
  const failed = (err: unknown) => {
    if (err instanceof HttpError) return err
    if (err instanceof OpencodeProvidersUnsupported) {
      return new HttpError(409, 'opencode_providers_v1', 'Connecting providers from Sillage needs OpenCode 2: update it in Settings › CLI versions, or run `opencode auth login`.')
    }
    return new HttpError(502, 'opencode_providers_failed', 'OpenCode could not do it: {error}.', { error: err instanceof Error ? err.message : String(err) })
  }

  app.get('/api/opencode/providers', async (request): Promise<OpencodeProviderListDto> => {
    requireAdmin(request)
    try {
      return { providers: await providers.list() }
    } catch (err) {
      throw failed(err)
    }
  })

  app.post('/api/opencode/providers/:id/key', async (request, reply) => {
    requireAdmin(request)
    const { id } = request.params as { id: string }
    const body = connectOpencodeKeyBodySchema.parse(request.body)
    try {
      await providers.connectKey(id, body.key, body.label)
    } catch (err) {
      throw failed(err)
    }
    return reply.status(204).send()
  })

  app.delete('/api/opencode/credentials/:id', async (request, reply) => {
    requireAdmin(request)
    const { id } = request.params as { id: string }
    try {
      await providers.disconnect(id)
    } catch (err) {
      throw failed(err)
    }
    return reply.status(204).send()
  })
}
