import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { conversationPaths, conversations, worktrees, type ProjectRow } from '@sillage/db'
import type { AppContext } from '../http/context.js'
import { createWorktree } from '../http/routes/worktrees.js'
import { defaultBase } from '../worktrees/assess.js'
import type { WorktreeCleanup } from '../worktrees/cleanup.js'
import type { WorktreeStatusService } from '../worktrees/status-service.js'
import { Refusal, type Requester } from './agent-requests-shared.js'

/** `create_worktree`, `list_worktrees` and `remove_worktree`: agents manage the project's trees as the Worktrees view does. */

/** Must match protocol `createWorktreeBodySchema`: names also become directories. */
export function assertWorktreeName(name: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.split('/').includes('..') || name.startsWith('/') || name.endsWith('/')) {
    throw new Refusal(`Invalid worktree name “${name}”: use only letters, digits, . _ - /, as for a Git branch.`)
  }
}

/** Agent-facing worktree state with its implications. */
const WORKTREE_STATE_WORDS = {
  missing: 'missing (directory gone)',
  dirty: 'uncommitted',
  unmerged: 'committed, awaiting merge',
  leftovers: 'merged, but files remain in the tree (commit, delete or ask the user whether to keep them)',
  merged: 'merged, nothing to retain (ready for cleanup)',
} as const

export class WorktreeRequests {
  constructor(
    private readonly ctx: AppContext,
    /** Worktree progress; absent means `list_worktrees` is rejected. */
    private readonly worktreeStatus?: WorktreeStatusService,
    /** Worktree cleanup; absent means `remove_worktree` is rejected. */
    private readonly worktreeCleanup?: WorktreeCleanup,
  ) {}

  // --- create_worktree, list_worktrees ---------------------------------------------

  /** Creates worktrees identically to the interface then attaches requesting sessions through `conversation_paths`, never `conversations.worktree_id`. The latter controls resume cwd, and changing it would lose Claude transcripts organized by working directory. Keep cwd and use absolute paths for worktree edits. New branches start from project default branches, not HEAD: requesting sessions often inhabit main trees left on unexpected branches. */
  async create(requester: Requester, project: ProjectRow, payload: Record<string, unknown>): Promise<string> {
    const branch = typeof payload.branch === 'string' ? payload.branch.trim() : ''
    if (!branch) throw new Refusal('The `branch` parameter is required: a branch name, e.g. `fix/truncated-title`.')
    assertWorktreeName(branch)

    const existing = this.ctx.db
      .select()
      .from(worktrees)
      .where(and(eq(worktrees.projectId, project.id), eq(worktrees.name, branch), isNull(worktrees.removedAt)))
      .get()

    let row = existing
    let origin: string
    if (row) {
      origin = 'Already existed: Sillage returns it as-is.'
    } else {
      const requested = typeof payload.base === 'string' ? payload.base.trim() : ''
      // Passed unchanged to `git worktree add`: leading hyphens would become options.
      if (requested && (!/^[A-Za-z0-9._/@{}^~-]+$/.test(requested) || requested.startsWith('-'))) {
        throw new Refusal(`Invalid base “${requested}”: expected a branch, tag or commit.`)
      }
      const base = requested || (await defaultBase(project.workspacePath)) || 'HEAD'
      row = await createWorktree(this.ctx, project, requester.userId, branch, base)
      origin = row.baseRef === branch
        ? `Branch “${branch}” already existed and is reused as-is.`
        : `New branch from ${base}.`
    }

    if (requester.id) {
      const now = Date.now()
      this.ctx.db
        .insert(conversationPaths)
        .values({ conversationId: requester.id, path: row.path, lastTs: now })
        .onConflictDoUpdate({
          target: [conversationPaths.conversationId, conversationPaths.path],
          set: { lastTs: sql`max(${conversationPaths.lastTs}, ${now})` },
        })
        .run()
    }
    this.worktreeStatus?.forget(project.id)

    return [
      `Worktree “${branch}” ready at ${row.path}. ${origin}`,
      requester.id
        ? 'Your session is attached: the user sees its branch in the sidebar and finds the tree in Worktrees for cleanup after merging.'
        : 'It appears in the project Worktrees view.',
      requester.id
        ? `Your working directory has not changed. Use absolute paths: edit files under ${row.path}, and run commands with \`cd ${row.path} && …\` or \`git -C ${row.path} …\`. Otherwise you would edit the original tree.`
        : null,
      `To start another session directly in this tree, start_session (when available) accepts \`worktree: "${branch}"\`.`,
    ]
      .filter((line) => line !== null)
      .join('\n')
  }

  /** Project trees and progress as shown in Worktrees. Await fresh calculations rather than return interface-acceptable stale lists because agents make reuse decisions from answers. */
  async list(requester: Requester, project: ProjectRow): Promise<string> {
    if (!this.worktreeStatus) throw new Refusal('Worktree progress is unavailable here.')
    const list = await this.worktreeStatus.fresh(project)
    if (list.worktrees.length === 0) {
      return list.base === null
        ? 'This project is not a Git repository: it has no worktrees.'
        : 'No worktrees outside the main tree. Use create_worktree to create one.'
    }

    const ids = [...new Set(list.worktrees.flatMap((tree) => tree.conversations.map((entry) => entry.id)))]
    const titles = new Map(
      ids.length
        ? this.ctx.db
            .select({ id: conversations.id, title: conversations.title, archivedAt: conversations.archivedAt })
            .from(conversations)
            .where(inArray(conversations.id, ids))
            .all()
            .map((row) => [row.id, row.archivedAt ? `${row.title} (archived)` : row.title])
        : [],
    )

    const lines = list.worktrees.map((tree) => {
      const facts = [
        tree.modified > 0 ? `${tree.modified} modified file(s)` : null,
        tree.untracked > 0 ? `${tree.untracked} untracked` : null,
        tree.ahead > 0 ? `${tree.ahead} commit(s) ahead` : null,
        tree.behind > 0 ? `${tree.behind} behind` : null,
        tree.conflicts ? 'conflict expected' : null,
        tree.kept > 0 ? `${tree.kept} leftover file(s) kept by the user` : null,
      ].filter(Boolean)
      const sessions = tree.conversations.map((entry) => {
        const who = entry.id === requester.id ? 'you' : `“${titles.get(entry.id) ?? entry.id}”`
        return `${who} ${entry.link === 'worktree' ? 'working here' : 'worked here'}`
      })
      return [
        `- \`${tree.name}\` : ${WORKTREE_STATE_WORDS[tree.state]}${facts.length ? ` (${facts.join(', ')})` : ''}`,
        `  ${tree.path}${tree.external ? ' · created outside Sillage' : ''}`,
        // Agents that merged and moved on need the names to sort what they left behind.
        ...(tree.state === 'leftovers'
          ? [`  Left: ${tree.files.map((file) => `${file.path} (${file.kind})`).join(', ')}${tree.modified + tree.untracked > tree.files.length ? ', …' : ''}`]
          : []),
        sessions.length ? `  Sessions: ${sessions.join('; ')}` : '  No attached sessions.',
      ].join('\n')
    })

    return [`Project worktrees, compared with ${list.base ?? 'HEAD'}:`, ...lines].join('\n')
  }

  // --- remove_worktree -----------------------------------------------------------

  /** Removes trees as the Worktrees cleanup does, so the database entry, services and sessions follow and the sidebar never shows a tree git has forgotten. Without `force`, only trees whose work is in the base go: an unattended session must not lose uncommitted or unmerged work by default. Only sessions that lived in the tree are archived, never those that merely wrote there, the requester included: their cwd is elsewhere and they carry on. */
  async remove(requester: Requester, project: ProjectRow, payload: Record<string, unknown>): Promise<string> {
    if (!this.worktreeStatus || !this.worktreeCleanup) throw new Refusal('Worktree cleanup is unavailable here.')
    const target = typeof payload.worktree === 'string' ? payload.worktree.trim() : ''
    if (!target) throw new Refusal('The `worktree` parameter is required: a name from list_worktrees, or the tree path.')
    const force = payload.force === true
    const deleteBranch = typeof payload.delete_branch === 'boolean' ? payload.delete_branch : null
    const archive = payload.archive_sessions !== false

    const list = await this.worktreeStatus.fresh(project)
    const tree = list.worktrees.find((entry) => entry.name === target || entry.branch === target || entry.path === target)
    if (!tree) throw new Refusal(`No worktree “${target}” in this project. Use list_worktrees to see them.`)
    if (requester.worktreeId !== null && requester.worktreeId === tree.id) {
      throw new Refusal('Refused: your session works in this tree. Remove it from a session at the project root, or leave it to the user in Worktrees.')
    }

    if (tree.state !== 'merged' && tree.state !== 'missing' && !force) {
      const loss = [
        tree.modified > 0 ? `${tree.modified} modified file(s)` : null,
        tree.untracked > 0 ? `${tree.untracked} untracked file(s)` : null,
        tree.ahead > 0 ? `${tree.ahead} commit(s) not in ${list.base ?? 'the base'}` : null,
      ].filter(Boolean)
      throw new Refusal(
        [
          `Refused: “${tree.name}” is ${WORKTREE_STATE_WORDS[tree.state]}${loss.length ? ` (${loss.join(', ')})` : ''}.`,
          // Leftover names let the agent decide what to commit, delete or ask about.
          tree.state === 'leftovers' && tree.files.length ? `Left: ${tree.files.map((file) => `${file.path} (${file.kind})`).join(', ')}.` : null,
          'Merge or commit first; pass `force: true` only if the user accepts losing what is not in the base.',
        ].filter(Boolean).join(' '),
      )
    }

    // Sessions whose cwd is the tree: the removal pulls the directory from under them.
    const living = tree.conversations.filter((entry) => entry.link === 'worktree' && entry.id !== requester.id).map((entry) => entry.id)
    const rows = living.length
      ? this.ctx.db
          .select({ id: conversations.id, title: conversations.title, status: conversations.status, archivedAt: conversations.archivedAt })
          .from(conversations)
          .where(inArray(conversations.id, living))
          .all()
      : []
    const working = rows.filter((row) => row.archivedAt === null && (row.status === 'running' || row.status === 'awaiting_input'))
    if (working.length > 0) {
      throw new Refusal(
        `Refused: ${working.map((row) => `“${row.title}”`).join(', ')} ${working.length > 1 ? 'are' : 'is'} still working in this tree. Wait with wait_for_session or interrupt first.`,
      )
    }

    const result = await this.worktreeCleanup.run(project, {
      path: tree.path,
      // Merged work survives in the base; otherwise keep the branch so forced removals lose only uncommitted files.
      deleteBranch: deleteBranch ?? (tree.state === 'merged' || tree.state === 'leftovers'),
      archiveSessions: archive ? rows.filter((row) => row.archivedAt === null).map((row) => row.id) : [],
      stopServices: true,
    })
    if (!result) throw new Refusal(`Worktree “${tree.name}” disappeared before Sillage could remove it. Call list_worktrees again.`)

    return [
      `Worktree “${tree.name}” removed (${tree.path}).`,
      tree.state === 'missing' ? 'Its directory was already gone; Sillage dropped the entry.' : null,
      tree.branch ? (result.branchDeleted ? `Branch “${tree.branch}” deleted.` : `Branch “${tree.branch}” kept.`) : null,
      result.archived > 0 ? `${result.archived} session(s) that lived there archived.` : null,
      result.stopped > 0 ? `${result.stopped} service(s) stopped.` : null,
    ]
      .filter((line) => line !== null)
      .join(' ')
  }
}
