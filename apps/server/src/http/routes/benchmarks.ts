import type { FastifyInstance } from 'fastify'
import { createBenchmarkBodySchema, type BenchmarkDto } from '@sillage/protocol'
import { benchmarksToDto, type BenchmarkRunner } from '../../benchmarks/runner.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../require-user.js'

/** Personal benchmarks: each account sees and controls only its own, like its discussions. */
export function registerBenchmarkRoutes(app: FastifyInstance, ctx: AppContext, runner: BenchmarkRunner): void {
  app.get('/api/benchmarks', async (request): Promise<BenchmarkDto[]> => {
    const user = requireUser(request)
    return runner.list(user.id)
  })

  app.post('/api/benchmarks', async (request, reply) => {
    const user = requireUser(request)
    const body = createBenchmarkBodySchema.parse(request.body)
    const row = await runner.create(user.id, body)
    return reply.status(201).send(benchmarksToDto(ctx.db, [row])[0])
  })

  app.get('/api/benchmarks/:id', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    return benchmarksToDto(ctx.db, [row])[0]!
  })

  app.post('/api/benchmarks/:id/cancel', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    await runner.cancel(row.id)
    return benchmarksToDto(ctx.db, [runner.load(row.id, user.id)])[0]!
  })

  app.delete('/api/benchmarks/:id', async (request, reply) => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    await runner.delete(row.id)
    return reply.status(204).send()
  })
}
