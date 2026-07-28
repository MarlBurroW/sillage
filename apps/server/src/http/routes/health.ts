import type { FastifyInstance } from 'fastify'
import { CURRENT_VERSION } from '../../update/version.js'

const startedAt = Date.now()

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => {
    const mem = process.memoryUsage()
    return {
      status: 'ok',
      // Après une mise à jour, le client sonde cette route (publique) pour savoir
      // quand la nouvelle version tourne réellement, pas juste que le port répond.
      version: CURRENT_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    }
  })
}
