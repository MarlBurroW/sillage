import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { CloneError, cloneRepository, setCredentialHelper, type CloneProgress } from './git.js'

export interface CloneJob {
  id: string
  status: 'running' | 'done' | 'failed'
  /** Ce que git dit de sa phase en cours, vide tant qu'il n'a rien dit. */
  phase: string
  percent: number | null
  /** Renseigné quand le clone a réussi : le projet créé dans la foulée. */
  projectId: string | null
  /** Un code que le client traduit, et un message anglais de repli. */
  error: { code: string; message: string } | null
}

export interface StartCloneParams {
  /** Qui a lancé le clone : personne d'autre n'a à en suivre l'avancement. */
  ownerId: string
  url: string
  destination: string
  /** Environnement du clone, qui porte la déclaration du helper de credentials. */
  env: NodeJS.ProcessEnv
  /** Valeur à inscrire dans le `.git/config` du dépôt une fois cloné. */
  helper: string
  /** Crée la ligne de projet et rend son identifiant. Appelé seulement si le clone réussit. */
  createProject: () => Promise<string>
}

/**
 * Suivi des clones en cours.
 *
 * En mémoire, et c'est suffisant : un clone ne survit pas au redémarrage du serveur, qui
 * tuerait le process git de toute façon. Un redémarrage pendant un clone laisse un
 * dossier à demi rempli, que l'utilisateur verra puisque le projet n'aura pas été créé.
 *
 * Le client interroge l'état plutôt que de le recevoir : le hub WebSocket est indexé par
 * conversation, et ouvrir une famille d'événements pour un flux qui dure une minute et
 * n'existe qu'à la création d'un projet coûterait plus qu'il ne rapporte.
 */
export class CloneJobs {
  private readonly jobs = new Map<string, { ownerId: string; job: CloneJob }>()

  /** Au-delà, un état terminé n'intéresse plus personne : le client l'a lu et est passé. */
  private static readonly RETENTION_MS = 10 * 60 * 1000

  start(params: StartCloneParams): CloneJob {
    const job: CloneJob = {
      id: randomUUID(),
      status: 'running',
      phase: '',
      percent: null,
      projectId: null,
      error: null,
    }
    this.jobs.set(job.id, { ownerId: params.ownerId, job })

    void this.run(job, params)
    return job
  }

  /** `undefined` aussi quand le clone appartient à quelqu'un d'autre : rien ne distingue
   * un identifiant inconnu d'un identifiant qui ne vous regarde pas. */
  get(id: string, ownerId: string): CloneJob | undefined {
    const entry = this.jobs.get(id)
    return entry?.ownerId === ownerId ? entry.job : undefined
  }

  private async run(job: CloneJob, params: StartCloneParams): Promise<void> {
    const onProgress = ({ phase, percent }: CloneProgress) => {
      job.phase = phase
      job.percent = percent
    }

    try {
      await cloneRepository(params.url, params.destination, params.env, onProgress)
      await setCredentialHelper(params.destination, params.helper)

      job.projectId = await params.createProject()
      job.percent = 100
      job.status = 'done'
    } catch (err) {
      // Un clone échoué laisse un dossier partiel que git ne nettoie pas toujours.
      // Le laisser ferait échouer la tentative suivante sur « destination non vide »,
      // avec un message qui n'explique pas le vrai problème.
      await rm(params.destination, { recursive: true, force: true }).catch(() => {})

      job.error =
        err instanceof CloneError
          ? { code: err.code, message: err.message }
          : // Tout ce qui n'est pas un échec de git : l'écriture de la configuration du
            // dépôt, ou la création du projet en base.
            { code: 'clone_failed', message: err instanceof Error ? err.message : String(err) }
      job.status = 'failed'
    } finally {
      setTimeout(() => this.jobs.delete(job.id), CloneJobs.RETENTION_MS).unref()
    }
  }
}
