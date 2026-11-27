import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { conversations, projectActions, type Db, type ProjectActionRow } from '@sillage/db'
import {
  MAX_ACTION_OUTPUT_CHARS,
  MAX_ACTIONS_PER_PROJECT,
  type CreateProjectActionBody,
  type ProjectActionDto,
  type ProjectActionRunResult,
  type ProjectActionServiceState,
  type ServiceActionControl,
  type TerminalDto,
  type UpdateProjectActionBody,
} from '@sillage/protocol'
import type { Config } from '../config.js'
import { HttpError, conflict, notFound } from '../http/errors.js'
import {
  controlServiceApp,
  scanServiceApps,
  serviceAppJournal,
  serviceAppsAvailable,
  startServiceApp,
} from '../services/apps.js'
import { processOrigins } from '../services/origins.js'
import { screenText, tailLines } from '../terminals/screen-text.js'
import { TerminalError, type TerminalManager } from '../terminals/terminal-manager.js'

/** Project action storage and execution in terminals or systemd units. Shared by routes and agent requests (`register_action`, `run_action`) so both reject identical cases and agents cannot mark newly written commands reviewed. */

/** Derive unit names solely from IDs so renaming actions does not lose running units. */
export function actionUnit(actionId: string): string {
  return `sillage-app-action-${actionId.slice(0, 8)}.service`
}

/** Service-log terminals use this separate key, outside the action's own terminal. */
const logsKey = (actionId: string) => `${actionId}:logs`

export function listActionRows(db: Db, projectIds: string[]): ProjectActionRow[] {
  if (projectIds.length === 0) return []
  return db
    .select()
    .from(projectActions)
    .where(inArray(projectActions.projectId, projectIds))
    .orderBy(asc(projectActions.createdAt))
    .all()
}

export function loadAction(db: Db, actionId: string): ProjectActionRow {
  const row = db.select().from(projectActions).where(eq(projectActions.id, actionId)).get()
  if (!row) throw notFound('action_not_found', 'Action not found.')
  return row
}

/** Null `agentConversationId` means interface-created and implicitly reviewed. */
export function createAction(
  db: Db,
  projectId: string,
  body: CreateProjectActionBody,
  agentConversationId: string | null,
): ProjectActionRow {
  const existing = db
    .select({ n: count() })
    .from(projectActions)
    .where(eq(projectActions.projectId, projectId))
    .get()
  if ((existing?.n ?? 0) >= MAX_ACTIONS_PER_PROJECT) {
    throw conflict('too_many_actions', `At most ${MAX_ACTIONS_PER_PROJECT} actions per project.`, {
      max: MAX_ACTIONS_PER_PROJECT,
    })
  }
  const now = Date.now()
  const row: ProjectActionRow = {
    id: randomUUID(),
    projectId,
    label: body.label,
    description: body.description || null,
    kind: body.kind,
    command: body.command,
    subdir: body.subdir || null,
    url: body.url || null,
    approvedAt: agentConversationId ? null : now,
    agentConversationId,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(projectActions).values(row).run()
  return row
}

/** Interface edits count as review. Agent edits reset actions to `proposed` whenever executable content changes: renaming buttons leaves risk unchanged, changing commands does not. */
export function updateAction(
  db: Db,
  row: ProjectActionRow,
  patch: UpdateProjectActionBody,
  agentConversationId: string | null,
): ProjectActionRow {
  const next: ProjectActionRow = {
    ...row,
    label: patch.label ?? row.label,
    description: patch.description === undefined ? row.description : patch.description || null,
    kind: patch.kind ?? row.kind,
    command: patch.command ?? row.command,
    subdir: patch.subdir === undefined ? row.subdir : patch.subdir || null,
    url: patch.url === undefined ? row.url : patch.url || null,
    updatedAt: Date.now(),
  }
  // URLs count as executable content because users follow links without rereading them.
  const executionChanged =
    next.kind !== row.kind || next.command !== row.command || next.subdir !== row.subdir || next.url !== row.url
  if (agentConversationId) {
    next.agentConversationId = agentConversationId
    if (executionChanged) next.approvedAt = null
  } else {
    next.approvedAt = next.updatedAt
  }
  db.update(projectActions).set(next).where(eq(projectActions.id, row.id)).run()
  return next
}

export function approveAction(db: Db, row: ProjectActionRow): ProjectActionRow {
  const next = { ...row, approvedAt: Date.now() }
  db.update(projectActions)
    .set({ approvedAt: next.approvedAt })
    .where(and(eq(projectActions.id, row.id), eq(projectActions.updatedAt, row.updatedAt)))
    .run()
  return next
}

export function deleteAction(db: Db, actionId: string): void {
  db.delete(projectActions).where(eq(projectActions.id, actionId)).run()
}

function toDto(
  row: ProjectActionRow,
  service: ProjectActionServiceState | null,
  terminal: TerminalDto | null,
  agentConversationTitle: string | null,
): ProjectActionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    description: row.description,
    kind: row.kind,
    command: row.command,
    subdir: row.subdir,
    url: row.url,
    status: row.approvedAt ? 'approved' : 'proposed',
    agentConversationId: row.agentConversationId,
    agentConversationTitle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    service,
    lastRun: terminal
      ? { terminalId: terminal.id, alive: terminal.alive, exitCode: terminal.exitCode, startedAt: terminal.createdAt }
      : null,
  }
}

/** Latest run of an action as text, for agents (`read_action_output`). */
export interface ActionOutput {
  /** A panel terminal, the unit's systemd journal, or nothing to read yet. */
  source: 'terminal' | 'journal' | 'none'
  /** `running`, `exited` or `interrupted` (daemon restart) for terminals; systemd ActiveState for units. */
  state: string
  exitCode: number | null
  startedAt: number | null
  cwd: string | null
  ports: number[]
  text: string
  /** Earlier lines left out by the line limit. */
  omitted: number
  /** The terminal buffer had already dropped the oldest output. */
  bufferTruncated: boolean
}

/** Directory a run's `cwd` was derived from, before the action's subdirectory was appended. */
export function worktreeOf(cwd: string, subdir: string | null): string {
  const depth = subdir ? subdir.split(/[\\/]/).filter((part) => part && part !== '.').length : 0
  return depth === 0 ? cwd : resolve(cwd, ...Array<string>(depth).fill('..'))
}

export class ActionRunner {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly terminals: TerminalManager,
  ) {}

  private shell(): string {
    return process.env.SHELL || '/bin/sh'
  }

  /** Unit states read in one pass for the whole list. */
  private async serviceStates(rows: ProjectActionRow[]): Promise<Map<string, ProjectActionServiceState>> {
    const states = new Map<string, ProjectActionServiceState>()
    if (!rows.some((row) => row.kind === 'service') || !(await serviceAppsAvailable())) return states
    const apps = await scanServiceApps(processOrigins(this.config.paths.data))
    const byUnit = new Map(apps.map((app) => [app.unit, app]))
    for (const row of rows) {
      if (row.kind !== 'service') continue
      const unit = actionUnit(row.id)
      const app = byUnit.get(unit)
      states.set(row.id, {
        unit,
        state: app?.state ?? 'inactive',
        cwd: app?.cwd ?? null,
        ports: app?.ports ?? [],
        startedAt: app?.startedAt ?? null,
      })
    }
    return states
  }

  async toDtos(rows: ProjectActionRow[]): Promise<ProjectActionDto[]> {
    const states = await this.serviceStates(rows)
    const authors = [...new Set(rows.map((row) => row.agentConversationId).filter((id) => id !== null))]
    const titles = new Map(
      authors.length === 0
        ? []
        : this.db
            .select({ id: conversations.id, title: conversations.title })
            .from(conversations)
            .where(inArray(conversations.id, authors))
            .all()
            .map((entry) => [entry.id, entry.title]),
    )
    return rows.map((row) =>
      toDto(
        row,
        states.get(row.id) ?? null,
        this.terminals.latestForAction(row.projectId, row.id),
        row.agentConversationId ? (titles.get(row.agentConversationId) ?? null) : null,
      ),
    )
  }

  async toDto(row: ProjectActionRow): Promise<ProjectActionDto> {
    return (await this.toDtos([row]))[0]!
  }

  /** Execution directory: supplied worktree plus action subdirectory. */
  private async cwdFor(row: ProjectActionRow, base: string): Promise<string> {
    const cwd = row.subdir ? join(base, row.subdir) : base
    const isDir = await stat(cwd).then((s) => s.isDirectory(), () => false)
    if (!isDir) {
      throw new HttpError(409, 'action_cwd_missing', 'The directory {path} does not exist.', { path: cwd })
    }
    return cwd
  }

  /** Launches actions. Return existing active runs rather than duplicate them: dev servers would compete for ports, test suites for databases. */
  async run(row: ProjectActionRow, base: string, conversationId: string | null): Promise<ProjectActionRunResult> {
    const cwd = await this.cwdFor(row, base)
    const origin = processOrigins(this.config.paths.data).environment(row.projectId, conversationId)

    if (row.kind === 'service' && (await serviceAppsAvailable())) {
      const current = (await this.serviceStates([row])).get(row.id)!
      if (['active', 'activating', 'reloading'].includes(current.state)) {
        return { terminal: null, service: current, alreadyRunning: true }
      }
      await startServiceApp({
        unit: current.unit,
        description: row.label,
        cwd,
        shell: this.shell(),
        command: row.command,
        env: origin,
      })
      return { terminal: null, service: (await this.serviceStates([row])).get(row.id)!, alreadyRunning: false }
    }

    const previous = this.terminals.latestForAction(row.projectId, row.id)
    if (previous?.alive) return { terminal: previous, service: null, alreadyRunning: true }
    const terminal = this.openTerminal(row.projectId, cwd, {
      command: row.command,
      title: row.label,
      actionId: row.id,
      env: origin,
    })
    return { terminal, service: null, alreadyRunning: false }
  }

  private openTerminal(...args: Parameters<TerminalManager['open']>) {
    try {
      return this.terminals.open(...args)
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'too_many_terminals') {
        throw conflict('too_many_terminals', err.message)
      }
      throw err
    }
  }

  /** Stops or restarts services, falling back to terminals without systemd. */
  async control(row: ProjectActionRow, op: ServiceActionControl, base: string): Promise<ProjectActionRunResult> {
    if (row.kind !== 'service') throw conflict('action_not_service', 'Only service actions can be stopped or restarted.')
    if (await serviceAppsAvailable()) {
      const current = (await this.serviceStates([row])).get(row.id)!
      if (current.state === 'inactive' || current.state === 'failed') {
        if (op === 'stop') return { terminal: null, service: current, alreadyRunning: false }
        return this.run(row, base, null)
      }
      await controlServiceApp(current.unit, op)
      return { terminal: null, service: current, alreadyRunning: false }
    }
    const previous = this.terminals.latestForAction(row.projectId, row.id)
    if (previous) this.terminals.close(previous.id)
    if (op === 'stop') return { terminal: null, service: null, alreadyRunning: false }
    // Restart in the worktree of the previous run. Its directory already includes the
    // subdirectory, which `run` adds again.
    return this.run(row, previous ? worktreeOf(previous.cwd, row.subdir) : base, null)
  }

  /** Service journal followed in a panel terminal. */
  async logs(row: ProjectActionRow, base: string): Promise<ProjectActionRunResult> {
    if (row.kind !== 'service' || !(await serviceAppsAvailable())) {
      throw conflict('action_no_logs', 'Only services run by systemd have a journal.')
    }
    const key = logsKey(row.id)
    const previous = this.terminals.latestForAction(row.projectId, key)
    if (previous?.alive) return { terminal: previous, service: null, alreadyRunning: true }
    const terminal = this.openTerminal(row.projectId, base, {
      command: `journalctl --user -u ${actionUnit(row.id)} -f -n 200 -o cat`,
      title: `${row.label} · logs`,
      actionId: key,
    })
    return { terminal, service: null, alreadyRunning: false }
  }

  /**
   * Latest run's output. Tasks, and services without systemd, are read from their terminal's
   * buffer, which is what the user sees in the panel; a still-running one can be waited on so an
   * agent gets the result in one call. systemd services are read from their journal.
   */
  async output(row: ProjectActionRow, lines: number, waitMs: number): Promise<ActionOutput> {
    if (row.kind === 'service' && (await serviceAppsAvailable())) {
      const service = (await this.serviceStates([row])).get(row.id)!
      // A journal the user cannot read (no persistent storage) reads as empty, not as a failure.
      const journal = await serviceAppJournal(service.unit, lines).catch(() => '')
      const { text } = tailLines(screenText(journal), lines, MAX_ACTION_OUTPUT_CHARS)
      return {
        source: text ? 'journal' : 'none',
        state: service.state,
        exitCode: null,
        startedAt: service.startedAt,
        cwd: service.cwd,
        ports: service.ports,
        text,
        omitted: 0,
        bufferTruncated: false,
      }
    }

    const latest = this.terminals.latestForAction(row.projectId, row.id)
    if (latest?.alive && waitMs > 0) await this.terminals.waitForExit(row.projectId, latest.id, waitMs)
    // Read again after the wait: a click may have replaced the run meanwhile.
    const terminal = this.terminals.latestForAction(row.projectId, row.id)
    const screen = terminal ? this.screen(row.projectId, terminal.id) : null
    if (!terminal || !screen) {
      return { source: 'none', state: 'never', exitCode: null, startedAt: null, cwd: null, ports: [], text: '', omitted: 0, bufferTruncated: false }
    }
    const { text, omitted } = tailLines(screen.text, lines, MAX_ACTION_OUTPUT_CHARS)
    return {
      source: 'terminal',
      state: terminal.alive ? 'running' : terminal.interrupted ? 'interrupted' : 'exited',
      exitCode: terminal.exitCode,
      startedAt: terminal.createdAt,
      cwd: terminal.cwd,
      ports: [],
      text,
      omitted,
      bufferTruncated: screen.truncated,
    }
  }

  /** Null when the terminal was closed between finding and reading it. */
  private screen(projectId: string, terminalId: string) {
    try {
      return this.terminals.output(projectId, terminalId)
    } catch (err) {
      if (err instanceof TerminalError) return null
      throw err
    }
  }

  /** On deletion, stop units that would otherwise run without a stop button. */
  async forget(row: ProjectActionRow): Promise<void> {
    if (row.kind === 'service' && (await serviceAppsAvailable())) {
      await controlServiceApp(actionUnit(row.id), 'stop').catch(() => undefined)
    }
  }
}
