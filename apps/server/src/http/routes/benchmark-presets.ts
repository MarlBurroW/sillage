import type { FastifyInstance } from 'fastify'
import { benchmarkPresetBodySchema, type BenchmarkPresetDto } from '@sillage/protocol'
import { BenchmarkPresets } from '../../benchmarks/presets.js'
import type { PriceCatalog } from '../../pricing/catalog.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../require-user.js'

/**
 * Personal presets of the benchmark form. Cookie-only like every benchmark route (bearer tokens
 * only reach `/api/v1`): a preset may carry a check script, which runs without approval once a
 * benchmark is launched from it, so no agent may write one.
 */
export function registerBenchmarkPresetRoutes(app: FastifyInstance, ctx: AppContext, prices: PriceCatalog | null = null): void {
  const presets = new BenchmarkPresets(ctx.db, prices)

  app.get('/api/benchmark-presets', async (request): Promise<BenchmarkPresetDto[]> => {
    const user = requireUser(request)
    return presets.list(user.id)
  })

  app.post('/api/benchmark-presets', async (request, reply) => {
    const user = requireUser(request)
    return reply.status(201).send(presets.create(user.id, benchmarkPresetBodySchema.parse(request.body)))
  })

  app.put('/api/benchmark-presets/:id', async (request): Promise<BenchmarkPresetDto> => {
    const user = requireUser(request)
    return presets.replace(user.id, (request.params as { id: string }).id, benchmarkPresetBodySchema.parse(request.body))
  })

  app.delete('/api/benchmark-presets/:id', async (request, reply) => {
    const user = requireUser(request)
    presets.remove(user.id, (request.params as { id: string }).id)
    return reply.status(204).send()
  })
}
