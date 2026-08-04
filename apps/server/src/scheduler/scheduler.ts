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
  private readonly running: Cron[] = []

  constructor(private readonly log: FastifyBaseLogger) {}

  register(job: ScheduledJob): void {
    if (this.jobs.has(job.name)) throw new Error(`Tâche planifiée en double : ${job.name}`)
    this.jobs.set(job.name, job)
  }

  start(): void {
    for (const job of this.jobs.values()) {
      this.running.push(
        new Cron(
          job.schedule,
          {
            name: job.name,
            // Un passage qui déborde sur le suivant ne se relance pas par-dessus
            // lui-même : les tâches écrivent toutes dans la même base SQLite, qui n'a
            // qu'un rédacteur.
            protect: (busy) =>
              this.log.warn(
                { job: job.name, since: busy.currentRun() },
                'tache planifiee encore en cours, passage saute',
              ),
            // Une tâche en attente ne doit pas retenir le process à l'arrêt.
            unref: true,
          },
          () => this.run(job),
        ),
      )
    }
    this.log.info({ jobs: [...this.jobs.keys()] }, 'taches planifiees demarrees')
  }

  stop(): void {
    for (const cron of this.running) cron.stop()
    this.running.length = 0
  }

  private async run(job: ScheduledJob): Promise<void> {
    const startedAt = Date.now()
    try {
      await job.run()
      this.log.debug({ job: job.name, ms: Date.now() - startedAt }, 'tache planifiee terminee')
    } catch (err) {
      // Attrapé ici pour qu'une tâche qui casse n'emporte ni le process ni ses voisines.
      this.log.error({ job: job.name, err }, 'tache planifiee en echec')
    }
  }
}
