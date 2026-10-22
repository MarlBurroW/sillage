import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { CloneError, cloneRepository, setCredentialHelper, type CloneProgress } from './git.js'

export interface CloneJob {
  id: string
  status: 'running' | 'done' | 'failed'
  /** Current phase reported by Git, empty until its first report. */
  phase: string
  percent: number | null
  /** Set after successful cloning: the project created immediately afterward. */
  projectId: string | null
  /** Client-translated code and fallback English message. */
  error: { code: string; message: string } | null
}

export interface StartCloneParams {
  /** Clone initiator; nobody else should track its progress. */
  ownerId: string
  url: string
  destination: string
  /** Clone environment including credential-helper registration. */
  env: NodeJS.ProcessEnv
  /** Value written to the clone's `.git/config`. */
  helper: string
  /** Creates the project row and returns its ID, only after successful cloning. */
  createProject: () => Promise<string>
}

/** Tracks ongoing clones in memory. Enough because server restart kills git anyway; interrupted clones leave partial directories users can see, with no project created. Clients poll rather than subscribe: the WebSocket hub is conversation-indexed, and adding an event family for a short project-creation-only flow costs more than it provides. */
export class CloneJobs {
  private readonly jobs = new Map<string, { ownerId: string; job: CloneJob }>()

  /** Completed states older than this are no longer useful: clients already read them. */
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

  /** Also `undefined` for other users' clones: unknown and inaccessible IDs are indistinguishable. */
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
      // Failed clones may leave partial directories git does not clean up.
      // Leaving them would make retries fail with 'destination not empty',
      // obscuring the original problem.
      await rm(params.destination, { recursive: true, force: true }).catch(() => {})

      job.error =
        err instanceof CloneError
          ? { code: err.code, message: err.message }
          : // Failures outside git: repository configuration writes
            // or database project creation.
            { code: 'clone_failed', message: err instanceof Error ? err.message : String(err) }
      job.status = 'failed'
    } finally {
      setTimeout(() => this.jobs.delete(job.id), CloneJobs.RETENTION_MS).unref()
    }
  }
}
