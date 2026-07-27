import type { FastifyInstance } from 'fastify'

const startedAt = Date.now()

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => {
    const mem = process.memoryUsage()
    return {
      status: 'ok',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    }
  })
}
