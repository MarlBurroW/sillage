import type { AgentKind } from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import { HttpError } from '../http/errors.js'

/** Keeps CLI updates and session work on the same CLI apart: an update starts only when nothing uses the CLI, and nothing new uses it while it installs. */
export class CliGate {
  private readonly updatingClis = new Set<AgentKind>()
  private readonly cliOperations = new Map<AgentKind, number>()

  constructor(private readonly registry: AgentRegistry) {}

  /** Rejects CLIs turned off with `[agents.<cli>] enabled = false`. Called before anything is written or spawned: the interface hides them, but stale clients, the API and scheduled tasks can still name them. */
  assertEnabled(kind: AgentKind): void {
    this.registry.adapter(kind).cli.assertEnabled()
  }

  /** Reserve the CLI synchronously before awaiting checkpoints/startup, when runner status can still be idle. */
  use(kind: AgentKind): () => void {
    this.assertEnabled(kind)
    if (this.updatingClis.has(kind)) {
      throw new HttpError(503, 'cli_updating', '{label} is being updated. Try again when installation finishes.',
        { label: this.registry.adapter(kind).label })
    }
    this.cliOperations.set(kind, (this.cliOperations.get(kind) ?? 0) + 1)
    return () => {
      const count = (this.cliOperations.get(kind) ?? 1) - 1
      if (count) this.cliOperations.set(kind, count)
      else this.cliOperations.delete(kind)
    }
  }

  /**
   * Marks the CLI as updating once no operation holds it and `sessions` finds nothing in the way
   * (it returns null then), after stopping the sessions it returns. Resolves to the release, or
   * null when the update has to wait.
   */
  async prepareUpdate(
    kind: AgentKind,
    sessions: () => string[] | null,
    stop: (conversationIds: string[]) => Promise<unknown>,
  ): Promise<(() => void) | null> {
    if (this.updatingClis.has(kind) || this.cliOperations.has(kind)) return null
    const stoppable = sessions()
    if (!stoppable) return null
    this.updatingClis.add(kind)
    try {
      await stop(stoppable)
      return () => { this.updatingClis.delete(kind) }
    } catch (err) {
      this.updatingClis.delete(kind)
      throw err
    }
  }
}
