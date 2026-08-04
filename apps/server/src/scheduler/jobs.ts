import type { Db } from '@sillage/db'
import type { FastifyBaseLogger } from 'fastify'
import type { AttachmentStore } from '../attachments/store.js'
import { purgeIdempotencyKeys } from '../auth/api-tokens.js'
import { purgeExpiredSessions } from '../auth/sessions.js'
import type { Scheduler } from './scheduler.js'

/**
 * Les ménages que `main` fait aussi au démarrage, ici pour qu'ils repassent ensuite.
 *
 * Les heures sont décalées les unes des autres : lancées à la même minute, trois
 * suppressions se sérialiseraient de toute façon derrière l'unique rédacteur SQLite,
 * au moment précis où les tours en cours en ont besoin.
 */
export function registerMaintenanceJobs(
  scheduler: Scheduler,
  deps: { db: Db; attachments: AttachmentStore; log: FastifyBaseLogger },
): void {
  scheduler.register({
    name: 'purge-expired-sessions',
    schedule: '0 * * * *',
    run: () => purgeExpiredSessions(deps.db),
  })

  scheduler.register({
    name: 'purge-idempotency-keys',
    schedule: '15 4 * * *',
    run: () => purgeIdempotencyKeys(deps.db),
  })

  scheduler.register({
    name: 'purge-orphan-attachments',
    schedule: '30 4 * * *',
    run: async () => {
      const orphans = await deps.attachments.purgeOrphans()
      if (orphans > 0) deps.log.info({ orphans }, 'pieces jointes orphelines supprimees')
    },
  })
}
