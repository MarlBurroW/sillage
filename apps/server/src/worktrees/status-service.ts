import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { conversationPaths, conversations, projects, worktreeKeptFiles, worktrees, type Db, type ProjectRow } from '@sillage/db'
import type { WorktreeLink, WorktreeStatusDto, WorktreeStatusListDto } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import { assessWorktree, defaultBase, listWorktrees, type WorktreeAssessment } from './assess.js'
import { hasOwnWork } from './own-work.js'

/** Recalculate lists older than this limit and reuse fresher ones. Keep short because sessions modify trees, but sidebar reads on every turn end would otherwise launch dozens of git processes. */
const TTL_MS = 30_000

/** Concurrent worktree assessments: each launches several git processes, costly for large repositories. */
const CONCURRENCY = 3

/** Delay before automatically recalculating projects after turns or git actions: simultaneous completions share one calculation. */
const REFRESH_DELAY_MS = 5_000

type ComputedListener = (project: ProjectRow, list: WorktreeStatusListDto) => void | Promise<void>

interface CacheEntry {
  value: WorktreeStatusListDto | null
  /** Invalidated by turns or git actions; serve once while recalculating. */
  stale: boolean
  /** Ongoing calculation shared by callers arriving before it completes. */
  pending: Promise<WorktreeStatusListDto> | null
}

/** Project worktree progress calculated per tree rather than session, cached until turn completion, git operations or worktree creation invalidates it. Return stale lists immediately while refreshing so sidebars never await `git status` on multi-gigabyte repositories. Only the first project request waits. */
export class WorktreeStatusService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly listeners: ComputedListener[] = []
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly db: Db,
    log: EventLog,
  ) {
    // Trees are most likely to change at turn completion;
    // edits outside cwd may attach sessions to new trees.
    log.subscribeAll((entry) => {
      if (entry.event.type !== 'turn.completed' && entry.event.type !== 'file.edited') return
      const row = this.db
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, entry.conversationId))
        .get()
      if (!row?.projectId) return
      this.invalidate(row.projectId)
      if (entry.event.type === 'turn.completed') this.scheduleRefresh(row.projectId)
    })
  }

  /** Notifies after each calculation, when merges become visible. With subscribers, also recalculate automatically after turns and git actions so agent merges are noticed even without an open interface. */
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
        // Database closed during daemon shutdown: nothing remains to recalculate.
      }
    }, REFRESH_DELAY_MS)
    timer.unref()
    this.refreshTimers.set(projectId, timer)
  }

  invalidate(projectId: string): void {
    const entry = this.cache.get(projectId)
    if (entry) entry.stale = true
  }

  /** Forget lists rather than mark stale after creating or removing worktrees: serving the old list during refresh would show newly deleted entries. */
  forget(projectId: string): void {
    this.cache.delete(projectId)
  }

  /** Invalidates projects whose workspace or worktrees match `cwd`. */
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
      // Clear the flag when calculation starts: invalidations arriving during calculation
      // must count because their state may not have been observed.
      entry.stale = false
      entry.pending = this.compute(project)
        .then((value) => {
          entry.value = value
          // Outside the response path: slow subscribers must not delay lists.
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
    // Return known stale lists immediately with their stale marker;
    // the new calculation serves the next read.
    if (current) return { ...current, fresh: false }
    return entry.pending
  }

  /** Like `get`, but awaits recalculation instead of returning stale lists. */
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

    // Reconcile by path: union git's list with database entries.
    // The main tree is not a work item and is excluded.
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

    const kept = new Map(
      this.db
        .select()
        .from(worktreeKeptFiles)
        .where(eq(worktreeKeptFiles.projectId, project.id))
        .all()
        .map((row) => [row.path, row]),
    )
    const result: WorktreeStatusDto[] = list.map((tree, index) => {
      const linked = this.linkedConversations(project.id, tree.id, tree.path)
      const { commitsInBase, ownCommits, ...assessment } = assessed[index]!
      return {
        id: tree.id,
        name: tree.name,
        path: tree.path,
        branch: tree.branch,
        external: tree.id === null,
        conversations: linked,
        ...assessment,
        ...this.settleLeftovers(tree.id, assessment, commitsInBase, ownCommits, linked, kept.get(tree.path)),
      }
    })

    // Most urgent first, then most recently active.
    const order = { missing: 0, dirty: 1, unmerged: 2, leftovers: 3, merged: 4 }
    result.sort(
      (a, b) =>
        order[a.state] - order[b.state] ||
        Math.max(b.lastEditAt ?? 0, b.lastCommitAt ?? 0) - Math.max(a.lastEditAt ?? 0, a.lastCommitAt ?? 0),
    )

    return { base, computedAt: Date.now(), fresh: true, worktrees: result }
  }

  /**
   * Tells a merged branch with files left behind from work in progress: a tree created a minute ago
   * with uncommitted edits also has every commit in the base. The branch reflog says whether it
   * delivered commits of its own; without one, fall back on the card heuristic (a last commit after
   * the tree was born), which a session committing on main just before branching can fool. Kept
   * leftovers count as merged only while their fingerprint still matches.
   */
  private settleLeftovers(
    id: string | null,
    assessment: Omit<WorktreeAssessment, 'commitsInBase' | 'ownCommits'>,
    commitsInBase: boolean,
    ownCommits: boolean | null,
    linked: { id: string }[],
    kept: { fingerprint: string; files: number } | undefined,
  ): Pick<WorktreeStatusDto, 'state' | 'fingerprint' | 'kept'> {
    const plain = { state: assessment.state, fingerprint: null, kept: 0 }
    if (assessment.state !== 'dirty' || !commitsInBase) return plain
    const delivered =
      ownCommits ??
      (assessment.ahead > 0 ||
        hasOwnWork(this.db, { id, lastCommitAt: assessment.lastCommitAt }, this.creationDates(linked)))
    if (!delivered) return plain
    if (kept && assessment.fingerprint && kept.fingerprint === assessment.fingerprint) {
      return { state: 'merged', fingerprint: null, kept: kept.files }
    }
    return { state: 'leftovers', fingerprint: assessment.fingerprint, kept: 0 }
  }

  private creationDates(linked: { id: string }[]): { createdAt: number }[] {
    if (linked.length === 0) return []
    return this.db
      .select({ createdAt: conversations.createdAt })
      .from(conversations)
      .where(inArray(conversations.id, linked.map((entry) => entry.id)))
      .all()
  }

  /** Conversations attached through cwd (`worktree_id`) or edits (`conversation_paths`). For the same conversation, the former takes precedence. */
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

    // Use substr rather than LIKE because directory names often contain underscore wildcards.
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
