import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { conversations, projectActions, type Db, type ProjectActionRow } from '@sillage/db'
import {
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
  serviceAppsAvailable,
  startServiceApp,
} from '../services/apps.js'
import { processOrigins } from '../services/origins.js'
import type { TerminalManager } from '../terminals/terminal-manager.js'

/**
 * Actions de projet : stockage, et exécution dans un terminal ou une unité systemd.
 *
 * Partagé entre les routes et les demandes des agents (`register_action`,
 * `run_action`) : les deux doivent refuser la même chose, et un agent ne doit pas
 * pouvoir faire passer pour relue une commande qu'il vient d'écrire.
 */

/** Nom d'unité tiré de l'identifiant seul : renommer l'action ne perd pas l'unité qui tourne. */
export function actionUnit(actionId: string): string {
  return `sillage-app-action-${actionId.slice(0, 8)}.service`
}

/** Le terminal de lecture du journal d'un service se range sous cette clé, à part de l'action. */
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

/** `agentConversationId` null : créée depuis l'interface, donc relue d'office. */
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

/**
 * Une modification par l'interface vaut relecture. Par un agent, elle remet l'action
 * en `proposed` dès qu'elle touche à ce qui s'exécute : renommer un bouton ne change
 * rien au risque, changer sa commande si.
 */
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
  // L'URL compte avec ce qui s'exécute : c'est un lien qu'on suivra sans le relire.
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

export class ActionRunner {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly terminals: TerminalManager,
  ) {}

  private shell(): string {
    return process.env.SHELL || '/bin/sh'
  }

  /** L'état des unités, lu en une passe pour toute la liste. */
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

  /** Le dossier d'exécution : le worktree donné, plus le sous-dossier de l'action. */
  private async cwdFor(row: ProjectActionRow, base: string): Promise<string> {
    const cwd = row.subdir ? join(base, row.subdir) : base
    const isDir = await stat(cwd).then((s) => s.isDirectory(), () => false)
    if (!isDir) {
      throw new HttpError(409, 'action_cwd_missing', 'The directory {path} does not exist.', { path: cwd })
    }
    return cwd
  }

  /**
   * Lance l'action. Une exécution qui tourne encore est rendue telle quelle plutôt que
   * doublée : deux serveurs de dev se disputeraient le port, deux suites de tests la base.
   */
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

  /** Arrêter ou relancer un service ; repli sur son terminal sans systemd. */
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
    return this.run(row, previous?.cwd ?? base, null)
  }

  /** Le journal d'un service, suivi dans un terminal du panneau. */
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

  /** À la suppression : une unité orpheline tournerait sans bouton pour l'arrêter. */
  async forget(row: ProjectActionRow): Promise<void> {
    if (row.kind === 'service' && (await serviceAppsAvailable())) {
      await controlServiceApp(actionUnit(row.id), 'stop').catch(() => undefined)
    }
  }
}
