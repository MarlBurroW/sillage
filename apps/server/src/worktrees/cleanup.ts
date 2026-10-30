import { rm, stat } from 'node:fs/promises'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { cards, conversations, worktreeKeptFiles, worktrees, type Db, type ProjectRow } from '@sillage/db'
import type {
  WorktreeBulkCleanupItemDto,
  WorktreeBulkCleanupResultDto,
  WorktreeCleanupPlanDto,
  WorktreeCleanupResultDto,
  WorktreeStatusDto,
} from '@sillage/protocol'
import { GitError, removeWorktree } from '../git.js'
import { deleteBranch } from '../git-workflow.js'
import { controlServiceApp, scanServiceApps, serviceAppsAvailable } from '../services/apps.js'
import { processOrigins, type ProcessOrigins } from '../services/origins.js'
import { readProcessHost } from '../services/ownership.js'
import { scanServiceProcesses, stopServiceProcess, type ServiceProcess } from '../services/processes.js'
import type { TerminalManager } from '../terminals/terminal-manager.js'
import type { WorktreeStatusService } from './status-service.js'

/** One-step worktree cleanup: stop its processes, archive sessions, remove tree and branch. Separate planning from execution so nothing disappears silently: confirmation shows the plan, then execution repeats discovery rather than trusting potentially stale lists. */
export class WorktreeCleanup {
  private readonly origins: ProcessOrigins

  constructor(
    private readonly db: Db,
    dataDirectory: string,
    private readonly status: WorktreeStatusService,
    private readonly terminals: TerminalManager,
    private readonly dropCheckpoints: (conversationId: string) => Promise<void>,
  ) {
    this.origins = processOrigins(dataDirectory)
  }

  /** Path-selected tree only when it belongs to the project, known to git or the database, never arbitrary directories. This is the sole guard between routes and `rm -rf`. */
  private async locate(project: ProjectRow, path: string): Promise<WorktreeStatusDto | null> {
    const list = await this.status.get(project)
    return list.worktrees.find((tree) => tree.path === path) ?? null
  }

  async plan(project: ProjectRow, path: string): Promise<WorktreeCleanupPlanDto | null> {
    const tree = await this.locate(project, path)
    if (!tree) return null
    const list = await this.status.get(project)

    const linked = tree.conversations.map((entry) => entry.id)
    const open = linked.length
      ? this.db
          .select({ id: conversations.id, title: conversations.title, cardId: conversations.cardId })
          .from(conversations)
          .where(and(inArray(conversations.id, linked), isNull(conversations.archivedAt)))
          .all()
      : []

    // Attached session's card, provided it has not already left the board.
    const cardIds = [...new Set(open.map((c) => c.cardId).filter((id): id is string => id !== null))]
    const card = cardIds.length
      ? this.db
          .select({ id: cards.id, number: cards.number, title: cards.title, column: cards.column })
          .from(cards)
          .where(inArray(cards.id, cardIds))
          .all()
          .find((entry) => entry.column !== 'done' && entry.column !== 'abandoned') ?? null
      : null

    return {
      path: tree.path,
      name: tree.name,
      branch: tree.branch,
      state: tree.state,
      modified: tree.modified,
      untracked: tree.untracked,
      ahead: tree.ahead,
      branchDeletable: tree.branch !== null && tree.branch !== list.base,
      conversations: open.map(({ id, title }) => ({ id, title })),
      services: (await this.servicesUnder(path)).map((s) => ({ id: s.id, label: s.label, kind: s.kind })),
      terminals: this.terminals.underCwd(path).length,
      card: card ? { id: card.id, number: card.number, title: card.title } : null,
    }
  }

  /** `archiveSessions` archives every linked session when true, or only the listed ids: agents archive the sessions that lived in the tree, never those that merely edited it, nor themselves. */
  async run(
    project: ProjectRow,
    options: { path: string; deleteBranch: boolean; archiveSessions: boolean | string[]; stopServices: boolean },
  ): Promise<WorktreeCleanupResultDto | null> {
    const tree = await this.locate(project, options.path)
    if (!tree) return null
    const base = (await this.status.get(project)).base
    const result = await this.remove(project, tree, base, options)
    this.status.forget(project.id)
    return result
  }

  /**
   * Removes every listed tree that still has nothing to lose. One fresh assessment serves the
   * whole request, taken when it arrives rather than when the user opened the confirmation: a
   * tree that gained work since then, or where a session is now working, is skipped and reported.
   * Busy means a session whose working directory is the tree; sessions that merely wrote there
   * (a long-lived supervisor at the root, typically) neither block nor get archived.
   */
  async runMany(
    project: ProjectRow,
    options: { paths: string[]; deleteBranch: boolean; archiveSessions: boolean; stopServices: boolean },
  ): Promise<WorktreeBulkCleanupResultDto> {
    this.status.invalidate(project.id)
    const list = await this.status.current(project)
    const byPath = new Map(list.worktrees.map((tree) => [tree.path, tree]))
    const items: WorktreeBulkCleanupItemDto[] = []

    for (const path of new Set(options.paths)) {
      const tree = byPath.get(path)
      if (!tree) {
        items.push({ path, name: path, outcome: 'skipped', reason: 'not_found', state: null })
        continue
      }
      if (tree.state !== 'merged' && tree.state !== 'missing') {
        items.push({ path, name: tree.name, outcome: 'skipped', reason: 'changed', state: tree.state })
        continue
      }
      const living = tree.conversations.filter((entry) => entry.link === 'worktree').map((entry) => entry.id)
      const rows = living.length
        ? this.db
            .select({ id: conversations.id, status: conversations.status })
            .from(conversations)
            .where(and(inArray(conversations.id, living), isNull(conversations.archivedAt)))
            .all()
        : []
      if (rows.some((row) => row.status === 'running' || row.status === 'awaiting_input')) {
        items.push({ path, name: tree.name, outcome: 'skipped', reason: 'busy', state: tree.state })
        continue
      }
      try {
        const result = await this.remove(project, tree, list.base, {
          deleteBranch: options.deleteBranch,
          archiveSessions: options.archiveSessions ? rows.map((row) => row.id) : [],
          stopServices: options.stopServices,
        })
        items.push({ path, name: tree.name, outcome: 'removed', ...result })
      } catch (err) {
        items.push({ path, name: tree.name, outcome: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    }

    // Once for the request: forgetting after each tree would reassess the whole project per removal.
    this.status.forget(project.id)
    return { items }
  }

  private async remove(
    project: ProjectRow,
    tree: WorktreeStatusDto,
    base: string | null,
    options: { deleteBranch: boolean; archiveSessions: boolean | string[]; stopServices: boolean },
  ): Promise<WorktreeCleanupResultDto> {
    const result: WorktreeCleanupResultDto = { removed: false, branchDeleted: false, archived: 0, stopped: 0 }

    // Stop running processes first: servers whose directories disappear underneath them
    // fail instead of shutting down cleanly.
    if (options.stopServices) {
      for (const service of await this.servicesUnder(tree.path)) {
        if (await service.stop()) result.stopped += 1
      }
    }
    for (const id of this.terminals.underCwd(tree.path)) this.terminals.close(id)

    const archivable = tree.conversations.filter(
      (entry) => options.archiveSessions === true || (Array.isArray(options.archiveSessions) && options.archiveSessions.includes(entry.id)),
    )
    if (archivable.length > 0) {
      const ids = archivable.map((entry) => entry.id)
      result.archived = this.db
        .update(conversations)
        .set({ archivedAt: Date.now() })
        .where(and(inArray(conversations.id, ids), isNull(conversations.archivedAt)))
        .run().changes
      // Turn snapshots live in the tree's repository: remove them before the tree.
      for (const id of ids) await this.dropCheckpoints(id).catch(() => undefined)
    }

    // `worktree remove --force` removes missing-directory entries individually:
    // avoid `prune`, which would silently purge other missing trees.
    try {
      await removeWorktree(project.workspacePath, tree.path, true)
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      // Git no longer knows this database-only entry: remove just its directory.
      if (await stat(tree.path).then((s) => s.isDirectory()).catch(() => false)) {
        await rm(tree.path, { recursive: true, force: true })
      }
    }
    result.removed = true

    if (options.deleteBranch && tree.branch && tree.branch !== base) {
      // Use `-D`: squash-merged branches are not ancestors and would fail `-d`.
      await deleteBranch(project.workspacePath, tree.branch, true)
        .then(() => { result.branchDeleted = true })
        .catch(() => undefined)
    }

    if (tree.id) {
      this.db.update(worktrees).set({ removedAt: Date.now() }).where(eq(worktrees.id, tree.id)).run()
    }
    // A tree recreated at the same path must not inherit a choice made for other files.
    this.db
      .delete(worktreeKeptFiles)
      .where(and(eq(worktreeKeptFiles.projectId, project.id), eq(worktreeKeptFiles.path, tree.path)))
      .run()
    return result
  }

  /** `sillage-app-*` apps and tracked processes whose directories lie inside the tree, each with its stop method. */
  private async servicesUnder(path: string): Promise<{ id: string; label: string; kind: 'app' | 'process'; stop: () => Promise<boolean> }[]> {
    if (process.platform !== 'linux') return []
    const prefix = `${path}/`
    const under = (cwd: string | null) => cwd !== null && (cwd === path || cwd.startsWith(prefix))
    const found: { id: string; label: string; kind: 'app' | 'process'; stop: () => Promise<boolean> }[] = []

    if (await serviceAppsAvailable()) {
      for (const app of await scanServiceApps(this.origins)) {
        if (!under(app.cwd) || !['active', 'activating', 'reloading'].includes(app.state)) continue
        found.push({
          id: app.id,
          label: app.description || app.unit,
          kind: 'app',
          stop: () => controlServiceApp(app.unit, 'stop').then(() => true, () => false),
        })
      }
    }
    let processes: ServiceProcess[] = []
    try {
      processes = await scanServiceProcesses(this.origins)
    } catch {
      return found
    }
    const host = await readProcessHost()
    for (const service of processes) {
      if (!under(service.cwd) || !service.origin || service.kind === 'launcher' || service.kind === 'helper') continue
      found.push({
        id: service.id,
        label: service.command ?? service.name,
        kind: 'process',
        stop: async () => stopServiceProcess(service, this.origins, host),
      })
    }
    return found
  }
}
