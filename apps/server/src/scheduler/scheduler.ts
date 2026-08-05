import { Cron } from 'croner'
import type { FastifyBaseLogger } from 'fastify'

export interface ScheduledJob {
  /** Identifiant en kebab-case, repris tel quel dans les journaux. */
  name: string
  /** Motif cron à cinq champs, lu dans le fuseau du serveur. */
  schedule: string
  run: () => void | Promise<unknown>
}

/**
 * Les travaux périodiques du serveur.
 *
 * Sillage a longtemps fait ses ménages une seule fois, au démarrage de `main`. Sur une
 * instance qui tient des semaines sans redémarrer, cela revient à ne jamais les faire.
 *
 * Un motif cron plutôt qu'un intervalle : « toutes les vingt-quatre heures » se compte
 * depuis le dernier redémarrage, donc l'heure de passage dérive à chaque déploiement et
 * finit par tomber en pleine séance de travail.
 */
export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>()
  private readonly armed = new Map<string, Cron>()
  /**
   * Posé par `start`, qui est le moment où l'ordonnanceur devient vivant.
   *
   * Nul avant, parce que le logger est celui de l'application et n'existe qu'une fois
   * celle-ci construite, alors que les tâches se déclarent avant.
   */
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

  /**
   * Change le motif d'une tâche sans redémarrer le serveur.
   *
   * Croner ne sait pas reprogrammer une tâche en vol : elle est coupée puis réarmée.
   * Un passage en cours va donc à son terme, seule la programmation suivante change.
   */
  reschedule(name: string, schedule: string): void {
    const job = this.jobs.get(name)
    if (!job) throw new Error(`Tâche planifiée inconnue : ${name}`)
    if (job.schedule === schedule) return

    job.schedule = schedule
    this.armed.get(name)?.stop()
    this.armed.delete(name)
    // Sans logger, l'ordonnanceur n'a pas démarré : la tâche partira sur son nouveau
    // motif au `start`, il n'y a rien à réarmer.
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
        // Un passage qui déborde sur le suivant ne se relance pas par-dessus lui-même :
        // les tâches écrivent toutes dans la même base SQLite, qui n'a qu'un rédacteur.
        protect: (busy) =>
          log.warn(
            { job: job.name, since: busy.currentRun() },
            'tache planifiee encore en cours, passage saute',
          ),
        // Une tâche en attente ne doit pas retenir le process à l'arrêt.
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
      // Attrapé ici pour qu'une tâche qui casse n'emporte ni le process ni ses voisines.
      log.error({ job: job.name, err }, 'tache planifiee en echec')
    }
  }
}
