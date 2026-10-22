import type { FastifyInstance } from 'fastify'
import { CURRENT_VERSION } from '../../update/version.js'

const startedAt = Date.now()

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => {
    const mem = process.memoryUsage()
    return {
      status: 'ok',
      // After updates, clients poll this public route to determine when the new
      // version is actually running, rather than merely checking that the port responds.
      version: CURRENT_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    }
  })
}
