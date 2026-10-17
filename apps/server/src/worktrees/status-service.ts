import { and, eq, isNull, sql } from 'drizzle-orm'
import { conversationPaths, conversations, projects, worktrees, type Db, type ProjectRow } from '@sillage/db'
import type { WorktreeLink, WorktreeStatusDto, WorktreeStatusListDto } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import { assessWorktree, defaultBase, listWorktrees } from './assess.js'

/**
 * Au-delà, une liste rendue est recalculée ; en deçà, elle est resservie telle quelle.
 * Court, parce que l'arbre bouge sous les sessions ; mais la barre latérale relit la
 * liste à chaque fin de tour, et sans ce délai chaque relecture lancerait des dizaines
 * de git.
 */
const TTL_MS = 30_000

/** Arbres jugés de front : chacun lance plusieurs git, un gros dépôt les sent passer. */
const CONCURRENCY = 3

/**
 * Délai avant de recalculer un projet de soi-même après un tour ou une action git :
 * plusieurs tours qui finissent ensemble ne coûtent qu'un calcul.
 */
const REFRESH_DELAY_MS = 5_000

type ComputedListener = (project: ProjectRow, list: WorktreeStatusListDto) => void | Promise<void>

interface CacheEntry {
  value: WorktreeStatusListDto | null
  /** Périmée par un tour ou une action git : resservie une fois, le temps de recalculer. */
  stale: boolean
  /** Calcul en cours, partagé entre les appelants qui arrivent pendant qu'il tourne. */
  pending: Promise<WorktreeStatusListDto> | null
}

/**
 * L'avancement des worktrees d'un projet, calculé par arbre et non par session, et
 * servi depuis un cache que la fin d'un tour, une action git ou une création de
 * worktree invalident.
 *
 * Une liste périmée est rendue tout de suite pendant que la suivante se calcule :
 * la barre latérale n'attend jamais un `git status` sur un dépôt de plusieurs
 * gigaoctets. Seul le tout premier appel d'un projet attend.
 */
export class WorktreeStatusService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly listeners: ComputedListener[] = []
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly db: Db,
    log: EventLog,
  ) {
    // La fin d'un tour est le moment où l'arbre a le plus de chances d'avoir changé ;
    // une édition hors du cwd peut rattacher la session à un nouvel arbre.
    log.subscribeAll((entry) => {
      if (entry.event.type !== 'turn.completed' && entry.event.type !== 'file.edited') return
      const row = this.db
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, entry.conversationId))
        .get()
      if (!row) return
      this.invalidate(row.projectId)
      if (entry.event.type === 'turn.completed') this.scheduleRefresh(row.projectId)
    })
  }

  /**
   * Prévient après chaque calcul : c'est là qu'une fusion se voit. Avec un abonné, le
   * service recalcule aussi de lui-même après un tour ou une action git, pour qu'une
   * fusion faite par un agent soit vue sans que personne n'ait l'interface ouverte.
   */
  onComputed(listener: ComputedListener): void {
    this.listeners.push(listener)
  }

  private scheduleRefresh(projectId: string): void {
    if (this.listeners.length === 0) return
    clearTimeout(this.refreshTimers.get(projectId))
    const timer = setTimeout(() => {
      this.refreshTimers.delete(projectId)
      try {
        const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
        if (project) void this.get(project).catch(() => undefined)
      } catch {
        // Base fermée à l'arrêt du daemon : il n'y a plus rien à recalculer.
      }
    }, REFRESH_DELAY_MS)
    timer.unref()
    this.refreshTimers.set(projectId, timer)
  }

  invalidate(projectId: string): void {
    const entry = this.cache.get(projectId)
    if (entry) entry.stale = true
  }

  /**
   * Oublie la liste au lieu de la périmer : après un arbre créé ou retiré, resservir
   * l'ancienne montrerait ce qu'on vient de supprimer, le temps du recalcul.
   */
  forget(projectId: string): void {
    this.cache.delete(projectId)
  }

  /** Invalide le projet dont le workspace ou l'un des worktrees est `cwd`. */
  invalidateForCwd(cwd: string): void {
    const project = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspacePath, cwd))
      .get()
    if (project) {
      this.invalidate(project.id)
      return this.scheduleRefresh(project.id)
    }
    const tree = this.db
      .select({ projectId: worktrees.projectId })
      .from(worktrees)
      .where(eq(worktrees.path, cwd))
      .get()
    if (tree) {
      this.invalidate(tree.projectId)
      this.scheduleRefresh(tree.projectId)
    }
  }

  async get(project: ProjectRow): Promise<WorktreeStatusListDto> {
    const entry = this.cache.get(project.id) ?? { value: null, stale: false, pending: null }
    this.cache.set(project.id, entry)

    const current = entry.value
    if (current && !entry.stale && Date.now() - current.computedAt < TTL_MS) return current

    if (!entry.pending) {
      // Le drapeau tombe au départ du calcul : une invalidation arrivée pendant qu'il
      // tourne doit compter, elle vise un état qu'il n'a peut-être pas vu.
      entry.stale = false
      entry.pending = this.compute(project)
        .then((value) => {
          entry.value = value
          // Hors du chemin de la réponse : un abonné lent ne retarde pas la liste.
          for (const listener of this.listeners) {
            void Promise.resolve()
              .then(() => listener(project, value))
              .catch((err: unknown) => console.warn('[worktrees] abonné en échec :', err))
          }
          return value
        })
        .finally(() => {
          entry.pending = null
        })
    }
    // Une liste connue mais périmée part tout de suite, signalée comme telle ; le
    // calcul lancé servira la lecture suivante.
    if (current) return { ...current, fresh: false }
    return entry.pending
  }

  /** Comme `get`, mais attend le recalcul plutôt que de rendre une liste périmée. */
  async current(project: ProjectRow): Promise<WorktreeStatusListDto> {
    const list = await this.get(project)
    if (list.fresh) return list
    return (await this.cache.get(project.id)?.pending) ?? list
  }

  private async compute(project: ProjectRow): Promise<WorktreeStatusListDto> {
    const repo = project.workspacePath
    const [entries, base] = await Promise.all([listWorktrees(repo), defaultBase(repo)])
    const rows = this.db
      .select()
      .from(worktrees)
      .where(and(eq(worktrees.projectId, project.id), isNull(worktrees.removedAt)))
      .all()

    // Réconciliation par chemin : ce que git liste, ce que la base connaît, l'union des
    // deux. L'arbre principal n'est pas un chantier, il sort de la liste.
    type Unified = {
      id: string | null
      name: string
      path: string
      branch: string | null
      head: string | null
      prunable: boolean
    }
    const unified = new Map<string, Unified>()
    for (const entry of entries) {
      if (entry.main) continue
      unified.set(entry.path, {
        id: null,
        name: entry.branch ?? entry.head?.slice(0, 7) ?? entry.path,
        path: entry.path,
        branch: entry.branch,
        head: entry.head,
        prunable: entry.prunable,
      })
    }
    for (const row of rows) {
      const known = unified.get(row.path)
      if (known) {
        known.id = row.id
        known.name = known.branch ?? row.name
      } else {
        unified.set(row.path, { id: row.id, name: row.name, path: row.path, branch: null, head: null, prunable: true })
      }
    }

    const list = [...unified.values()]
    const assessed = await mapLimited(list, CONCURRENCY, (tree) =>
      base
        ? assessWorktree(repo, base, tree)
        : assessWorktree(repo, 'HEAD', { ...tree, head: null }),
    )

    const result: WorktreeStatusDto[] = list.map((tree, index) => ({
      id: tree.id,
      name: tree.name,
      path: tree.path,
      branch: tree.branch,
      external: tree.id === null,
      conversations: this.linkedConversations(project.id, tree.id, tree.path),
      ...assessed[index]!,
    }))

    // Les plus urgents d'abord, puis les plus récemment actifs.
    const order = { missing: 0, dirty: 1, unmerged: 2, merged: 3 }
    result.sort(
      (a, b) =>
        order[a.state] - order[b.state] ||
        Math.max(b.lastEditAt ?? 0, b.lastCommitAt ?? 0) - Math.max(a.lastEditAt ?? 0, a.lastCommitAt ?? 0),
    )

    return { base, computedAt: Date.now(), fresh: true, worktrees: result }
  }

  /**
   * Les conversations tenues à un arbre : par leur cwd (`worktree_id`), ou parce
   * qu'elles y ont écrit (voir `conversation_paths`). Le premier lien l'emporte sur le
   * second pour une même conversation.
   */
  private linkedConversations(
    projectId: string,
    worktreeId: string | null,
    path: string,
  ): { id: string; link: WorktreeLink }[] {
    const linked = new Map<string, WorktreeLink>()

    if (worktreeId) {
      const direct = this.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.worktreeId, worktreeId))
        .all()
      for (const row of direct) linked.set(row.id, 'worktree')
    }

    // `substr` plutôt que LIKE : un nom de dossier porte souvent `_`, joker de LIKE.
    const prefix = `${path}/`
    const edited = this.db
      .select({ id: conversationPaths.conversationId })
      .from(conversationPaths)
      .innerJoin(conversations, eq(conversations.id, conversationPaths.conversationId))
      .where(
        and(
          eq(conversations.projectId, projectId),
          sql`(${conversationPaths.path} = ${path} OR substr(${conversationPaths.path}, 1, ${prefix.length}) = ${prefix})`,
        ),
      )
      .groupBy(conversationPaths.conversationId)
      .all()
    for (const row of edited) if (!linked.has(row.id)) linked.set(row.id, 'edited')

    return [...linked].map(([id, link]) => ({ id, link }))
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
