import {
  createProjectActionBodySchema,
  updateProjectActionBodySchema,
  type ProjectActionRunResult,
} from '@sillage/protocol'
import {
  createAction,
  deleteAction,
  loadAction,
  updateAction,
  type ActionRunner,
} from '../actions/actions.js'
import type { AppContext } from '../http/context.js'
import { resolveConversationCwd } from '../workspace.js'
import { describeZod, Refusal, type Requester } from './agent-requests-shared.js'

/** Project action requests: `register_action`, `remove_action` and `run_action`. */
export class ActionRequests {
  constructor(
    private readonly ctx: AppContext,
    /** Optional in unrelated tests; absent means `run_action` is rejected. */
    private readonly actions?: ActionRunner,
  ) {}

  private projectAction(requester: Requester, id: unknown) {
    if (typeof id !== 'string' || !id) throw new Refusal('The `id` parameter is required (see list_actions).')
    try {
      const row = loadAction(this.ctx.db, id)
      if (row.projectId === requester.projectId) return row
    } catch {
      // Same response as for another project's action.
    }
    throw new Refusal(`No action \`${id}\` in this project: use list_actions for IDs.`)
  }

  /** Create/edit as `proposed` so users review commands before clicking to launch. Renaming or redescribing reviewed buttons does not change status. */
  register(requester: Requester, payload: Record<string, unknown>): string {
    const fields = Object.fromEntries(
      ['label', 'description', 'kind', 'command', 'subdir', 'url']
        .filter((key) => payload[key] !== undefined && payload[key] !== null)
        .map((key) => [key, payload[key]]),
    )
    if (payload.id !== undefined && payload.id !== null && payload.id !== '') {
      const row = this.projectAction(requester, payload.id)
      const parsed = updateProjectActionBodySchema.safeParse(fields)
      if (!parsed.success) throw new Refusal(describeZod(parsed.error))
      const next = updateAction(this.ctx.db, row, parsed.data, requester.id || null)
      return next.approvedAt
        ? `Action “${next.label}” updated; it remains approved.`
        : `Action “${next.label}” updated. Its command changed: the user must approve it before a one-click launch.`
    }
    const parsed = createProjectActionBodySchema.safeParse(fields)
    if (!parsed.success) throw new Refusal(describeZod(parsed.error))
    const row = createAction(this.ctx.db, requester.projectId, parsed.data, requester.id || null)
    return `Action “${row.label}” (${row.kind}, id ${row.id}) proposed. It appears in the Actions panel; the user approves it before the first launch.`
  }

  async remove(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    const row = this.projectAction(requester, payload.id)
    await this.actions?.forget(row)
    deleteAction(this.ctx.db, row.id)
    return `Action “${row.label}” deleted${row.kind === 'service' ? ', and its service stopped' : ''}.`
  }

  /** Runs actions in requester worktrees, even proposed actions: agents could run identical shell commands already. Review protects user clicks rather than agents from themselves. */
  async run(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    if (!this.actions) throw new Refusal('Actions are unavailable on this server.')
    const row = this.projectAction(requester, payload.id)
    const result = await this.actions.run(row, resolveConversationCwd(this.ctx.db, requester), requester.id || null)
    if (result.service) {
      // Wait briefly to observe immediate failures (occupied ports, missing commands).
      if (!result.alreadyRunning) await new Promise((resolve) => setTimeout(resolve, 2000))
      const fresh = await this.actions.toDto(row)
      return describeRun(row.label, result, fresh.service)
    }
    return describeRun(row.label, result, null)
  }
}

function describeRun(
  label: string,
  result: ProjectActionRunResult,
  service: ProjectActionRunResult['service'],
): string {
  if (service) {
    const ports = service.ports.length > 0 ? `, ports ${service.ports.join(', ')}` : ''
    const state = `unit ${service.unit}: ${service.state}${ports}`
    if (result.alreadyRunning) return `“${label}” was already running (${state}).`
    if (service.state === 'failed') {
      return `“${label}” failed to start (${state}). Logs: journalctl --user -u ${service.unit} -n 50`
    }
    return `“${label}” started (${state}). Logs: journalctl --user -u ${service.unit} -n 50`
  }
  const terminal = result.terminal
  if (result.alreadyRunning) return `“${label}” is already running in panel terminal “${terminal?.title ?? label}”.`
  return `“${label}” started in a panel terminal visible to the user. You cannot read its output: run the command in your shell if you need the result yourself.`
}
