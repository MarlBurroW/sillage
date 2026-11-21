import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { FastifyInstance } from 'fastify'
import { migrationState } from '../../migrations.js'
import { CURRENT_VERSION } from '../../update/version.js'

const startedAt = Date.now()

/** Window over which event-loop delay is measured, and the stall worth a log line. */
const LOOP_WINDOW_MS = 60_000
const LOOP_STALL_MS = 1000

/**
 * `status` stays a constant `ok`: the installer, the update poll and container liveness probes
 * read this route, and a failing answer on a slow moment would restart a daemon hosting every
 * session. What it adds is evidence: the event loop's delay over the last minute (one daemon runs
 * every session, so a synchronous query or a large parse stalls them all) and whether the database
 * was migrated by a newer release.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  let loop = { p99Ms: 0, maxMs: 0 }
  const timer = setInterval(() => {
    loop = { p99Ms: Math.round(histogram.percentile(99) / 1e6), maxMs: Math.round(histogram.max / 1e6) }
    histogram.reset()
    // After the fact, a stuck session is otherwise unexplained: say when the daemon stopped answering.
    if (loop.maxMs >= LOOP_STALL_MS) app.log.warn({ loopMaxMs: loop.maxMs, loopP99Ms: loop.p99Ms }, 'event loop stalled')
  }, LOOP_WINDOW_MS)
  timer.unref()
  app.addHook('onClose', async () => {
    clearInterval(timer)
    histogram.disable()
  })

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
      loop,
      schema: migrationState.newerThanRelease ? 'newer' : 'current',
    }
  })
}
