import { Cron } from 'croner'
import type { FastifyBaseLogger } from 'fastify'

export interface ScheduledJob {
  /** Kebab-case identifier used unchanged in logs. */
  name: string
  /** Five-field cron expression interpreted in the server timezone. */
  schedule: string
  run: () => void | Promise<unknown>
}

/** Periodic server jobs. Housekeeping used to run only when `main` started, effectively never on instances staying up for weeks. Use cron rather than intervals: twenty-four-hour intervals shift with deployments and eventually run during active work. */
export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>()
  private readonly armed = new Map<string, Cron>()
  /** Set by `start` when the scheduler becomes active. Null beforehand because the application logger exists only after application construction, whereas jobs are declared earlier. */
  private log: FastifyBaseLogger | null = null

  register(job: ScheduledJob): void {
    if (this.jobs.has(job.name)) throw new Error(`Tâche planifiée en double : ${job.name}`)
    this.jobs.set(job.name, job)
  }

  start(log: FastifyBaseLogger): void {
    this.log = log
    for (const job of this.jobs.values()) this.arm(job, log)
    log.info({ jobs: [...this.jobs.keys()] }, 'taches planifiees demarrees')
  }

  /** Changes job schedules without restarting. Croner cannot reschedule active jobs, so stop and rearm them. Current runs finish; only the next schedule changes. */
  reschedule(name: string, schedule: string): void {
    const job = this.jobs.get(name)
    if (!job) throw new Error(`Tâche planifiée inconnue : ${name}`)
    if (job.schedule === schedule) return

    job.schedule = schedule
    this.armed.get(name)?.stop()
    this.armed.delete(name)
    // Without a logger the scheduler has not started: `start` will use the new
    // expression, so nothing needs rearming.
    if (this.log) {
      this.arm(job, this.log)
      this.log.info({ job: name, schedule }, 'tache planifiee reprogrammee')
    }
  }

  stop(): void {
    for (const cron of this.armed.values()) cron.stop()
    this.armed.clear()
  }

  private arm(job: ScheduledJob, log: FastifyBaseLogger): void {
    const cron = new Cron(
      job.schedule,
      {
        name: job.name,
        // Never overlap jobs with themselves: all write to the same SQLite database,
        // which has only one writer.
        protect: (busy) =>
          log.warn(
            { job: job.name, since: busy.currentRun() },
            'tache planifiee encore en cours, passage saute',
          ),
        // Pending jobs must not keep processes alive during shutdown.
        unref: true,
      },
      () => this.run(job, log),
    )
    this.armed.set(job.name, cron)
  }

  private async run(job: ScheduledJob, log: FastifyBaseLogger): Promise<void> {
    const startedAt = Date.now()
    try {
      await job.run()
      log.debug({ job: job.name, ms: Date.now() - startedAt }, 'tache planifiee terminee')
    } catch (err) {
      // Catch here so failing jobs affect neither the process nor other jobs.
      log.error({ job: job.name, err }, 'tache planifiee en echec')
    }
  }
}
