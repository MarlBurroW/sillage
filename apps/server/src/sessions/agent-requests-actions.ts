import {
  DEFAULT_ACTION_OUTPUT_LINES,
  MAX_ACTION_OUTPUT_LINES,
  MAX_ACTION_OUTPUT_WAIT_SECONDS,
  createProjectActionBodySchema,
  updateProjectActionBodySchema,
  type ProjectActionRunResult,
} from '@sillage/protocol'
import type { ProjectActionRow } from '@sillage/db'
import {
  createAction,
  deleteAction,
  loadAction,
  updateAction,
  type ActionOutput,
  type ActionRunner,
} from '../actions/actions.js'
import { ago } from '../agents/overview.js'
import type { AppContext } from '../http/context.js'
import { resolveConversationCwd } from '../workspace.js'
import { describeZod, Refusal, type Requester } from './agent-requests-shared.js'

/** Project action requests: `register_action`, `remove_action`, `run_action` and `read_action_output`. */
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
    // Without a runner nothing could have started the service, so there is nothing to claim stopped.
    return `Action “${row.label}” deleted${row.kind === 'service' && this.actions ? ', and its service stopped' : ''}.`
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

  /** Latest run's output, whoever started it: the user's click is the usual case (“I ran the tests, look at the failure”). */
  async output(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    if (!this.actions) throw new Refusal('Actions are unavailable on this server.')
    const row = this.projectAction(requester, payload.id)
    const lines = boundedInteger(payload.lines, 'lines', 1, MAX_ACTION_OUTPUT_LINES) ?? DEFAULT_ACTION_OUTPUT_LINES
    const wait = boundedInteger(payload.wait, 'wait', 0, MAX_ACTION_OUTPUT_WAIT_SECONDS) ?? 0
    return describeOutput(row, await this.actions.output(row, lines, wait * 1000), lines)
  }
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Refusal(`\`${name}\` must be an integer from ${min} to ${max}.`)
  }
  return value as number
}

function describeOutput(row: ProjectActionRow, output: ActionOutput, lines: number): string {
  const label = `“${row.label}” (${row.kind})`
  if (output.source === 'none') {
    if (output.state === 'never') return `${label} has no run to read: it was never launched, or its terminal was closed. Start it with run_action.`
    return `${label}: unit ${output.state}, nothing in its journal yet.`
  }
  const now = Date.now()
  const when = output.startedAt ? `, started ${ago(output.startedAt, now)}` : ''
  const where = output.cwd ? ` in ${output.cwd}` : ''
  const ports = output.ports.length > 0 ? `, ports ${output.ports.join(', ')}` : ''
  const state =
    output.source === 'journal'
      ? `unit ${output.state}${ports}`
      : output.state === 'running'
        ? 'still running'
        : output.state === 'interrupted'
          ? 'interrupted by a Sillage restart'
          : output.exitCode === 0
            ? 'finished successfully (exit 0)'
            : `failed (exit ${output.exitCode})`
  const notes = [
    output.omitted > 0 ? `${output.omitted} earlier lines not shown${lines < MAX_ACTION_OUTPUT_LINES ? `, pass \`lines\` (up to ${MAX_ACTION_OUTPUT_LINES}) for more` : ''}` : null,
    output.bufferTruncated ? 'the terminal only keeps its most recent output, so the start of the run is gone' : null,
    output.state === 'running' && output.source === 'terminal' ? `pass \`wait\` (up to ${MAX_ACTION_OUTPUT_WAIT_SECONDS} s) to wait for it to finish` : null,
  ].filter(Boolean)
  const heading = output.source === 'journal' ? `Last ${lines} journal lines` : 'Latest output'
  return [
    `${label}: ${state}${when}${where}.`,
    notes.length > 0 ? `Note: ${notes.join('; ')}.` : null,
    `${heading}:`,
    '```text',
    output.text || '(no output)',
    '```',
  ].filter((part) => part !== null).join('\n')
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
      return `“${label}” failed to start (${state}). Read its logs with read_action_output.`
    }
    return `“${label}” started (${state}). Read its logs with read_action_output.`
  }
  const terminal = result.terminal
  if (result.alreadyRunning) {
    return `“${label}” is already running in panel terminal “${terminal?.title ?? label}”. Read its output with read_action_output.`
  }
  return `“${label}” started in a panel terminal the user can open. Read its output with read_action_output; pass \`wait\` to get the result once it finishes.`
}
