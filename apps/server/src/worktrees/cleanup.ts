import { rm, stat } from 'node:fs/promises'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { cards, conversations, worktrees, type Db, type ProjectRow } from '@sillage/db'
import type { WorktreeCleanupPlanDto, WorktreeCleanupResultDto, WorktreeStatusDto } from '@sillage/protocol'
import { GitError, removeWorktree } from '../git.js'
import { deleteBranch } from '../git-workflow.js'
import { controlServiceApp, scanServiceApps, serviceAppsAvailable } from '../services/apps.js'
import { processOrigins, type ProcessOrigins } from '../services/origins.js'
import { readProcessHost } from '../services/ownership.js'
import { scanServiceProcesses, stopServiceProcess, type ServiceProcess } from '../services/processes.js'
import type { TerminalManager } from '../terminals/terminal-manager.js'
import type { WorktreeStatusService } from './status-service.js'

/**
 * Nettoyer un chantier en un geste : arrêter ce qui y tourne, ranger ses sessions,
 * retirer l'arbre et sa branche.
 *
 * Deux temps, le plan puis l'exécution, parce que rien ici ne doit partir en silence :
 * la confirmation montre ce que le plan a trouvé, et l'exécution refait les mêmes
 * recherches au moment d'agir plutôt que de se fier à une liste qui a pu vieillir.
 */
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

  /**
   * L'arbre désigné par son chemin, s'il appartient bien au projet : connu de git ou de
   * la base, jamais un dossier quelconque. C'est la seule garde entre une route et un
   * `rm -rf`.
   */
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

    // La carte d'une session rattachée, si elle n'est pas déjà sortie du board.
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

  async run(
    project: ProjectRow,
    options: { path: string; deleteBranch: boolean; archiveSessions: boolean; stopServices: boolean },
  ): Promise<WorktreeCleanupResultDto | null> {
    const tree = await this.locate(project, options.path)
    if (!tree) return null
    const base = (await this.status.get(project)).base
    const result: WorktreeCleanupResultDto = { removed: false, branchDeleted: false, archived: 0, stopped: 0 }

    // Ce qui tourne dedans d'abord : un serveur dont le dossier disparaît sous lui ne
    // s'arrête pas proprement, il se met en échec.
    if (options.stopServices) {
      for (const service of await this.servicesUnder(tree.path)) {
        if (await service.stop()) result.stopped += 1
      }
    }
    for (const id of this.terminals.underCwd(tree.path)) this.terminals.close(id)

    if (options.archiveSessions && tree.conversations.length > 0) {
      const ids = tree.conversations.map((entry) => entry.id)
      result.archived = this.db
        .update(conversations)
        .set({ archivedAt: Date.now() })
        .where(and(inArray(conversations.id, ids), isNull(conversations.archivedAt)))
        .run().changes
      // Les captures de tour vivent dans le dépôt de l'arbre : à retirer avant lui.
      for (const id of ids) await this.dropCheckpoints(id).catch(() => undefined)
    }

    // `worktree remove --force` retire aussi une entrée dont le dossier a disparu, et
    // elle seule : pas de `prune`, qui purgerait en silence les autres arbres perdus.
    try {
      await removeWorktree(project.workspacePath, tree.path, true)
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      // Git ne le connaît plus (entrée en base seulement) : le dossier part seul.
      if (await stat(tree.path).then((s) => s.isDirectory()).catch(() => false)) {
        await rm(tree.path, { recursive: true, force: true })
      }
    }
    result.removed = true

    if (options.deleteBranch && tree.branch && tree.branch !== base) {
      // `-D` : une branche fusionnée par squash n'est pas un ancêtre, `-d` la refuserait.
      await deleteBranch(project.workspacePath, tree.branch, true)
        .then(() => { result.branchDeleted = true })
        .catch(() => undefined)
    }

    if (tree.id) {
      this.db.update(worktrees).set({ removedAt: Date.now() }).where(eq(worktrees.id, tree.id)).run()
    }
    this.status.forget(project.id)
    return result
  }

  /**
   * Les apps `sillage-app-*` et les processus suivis dont le répertoire est dans
   * l'arbre, chacun avec la façon de l'arrêter.
   */
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
