import type { Db } from '@sillage/db'
import type { FastifyBaseLogger } from 'fastify'
import type { AttachmentStore } from '../attachments/store.js'
import { purgeIdempotencyKeys } from '../auth/api-tokens.js'
import { purgeExpiredSessions } from '../auth/sessions.js'
import type { Config } from '../config.js'
import { runArchivePass } from '../conversations/auto-archive.js'
import { readAppSettings } from '../settings/app-settings.js'
import type { Scheduler } from './scheduler.js'

/** Named so settings routes can identify and reschedule it. */
export const ARCHIVE_JOB = 'archive-stale-conversations'

/** Housekeeping also performed by `main` at startup, registered here for repetition. Offset schedules: simultaneous deletions would serialize behind SQLite's sole writer precisely when active turns need it. */
export function registerMaintenanceJobs(
  scheduler: Scheduler,
  deps: { db: Db; attachments: AttachmentStore; log: FastifyBaseLogger; config: Config },
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

  scheduler.register({
    name: ARCHIVE_JOB,
    // Only nonconstant schedule: configurable through the interface,
    // whose settings route rearms it with the new value.
    schedule: readAppSettings(deps.db, deps.config).autoArchiveSchedule,
    run: () => {
      // Reread delays each pass rather than fix them at registration:
      // settings are editable through the interface, and deferring changes until restart
      // would defeat that purpose.
      const archived = runArchivePass(deps.db, deps.config)
      if (archived) deps.log.info({ archived }, 'conversations rangees pour inactivite')
    },
  })
}
