import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { boardLinks, cardIssues, cards, projects, users, writeTransaction, type ProjectRow } from '@sillage/db'
import {
  agentConfigSchema,
  boardLinkSettingsSchema,
  type AgentConfig,
  type BoardLinkDto,
  type BoardLinkStateDto,
} from '@sillage/protocol'
import { hasLocalWork, parseHidden, type BoardSync } from '../../board/board-sync.js'
import type { AppContext } from '../context.js'
import { conflict, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

const execFileAsync = promisify(execFile)

const GITHUB_REMOTE =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i

/** `owner/name` from GitHub remote URLs in HTTPS, SSH and SCP forms. */
export function githubRepoFromRemote(url: string): string | null {
  const match = GITHUB_REMOTE.exec(url.trim())
  return match ? `${match[1]}/${match[2]}` : null
}

/** Stored session configuration; unreadable rows mean 'project settings'. */
function readSessionConfig(value: string | null): AgentConfig | null {
  if (!value) return null
  try {
    const parsed = agentConfigSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** GitHub repository from the project's `origin`, used to prefill the connection. */
async function originRepo(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'remote', 'get-url', 'origin'], { timeout: 3000 })
    return githubRepoFromRemote(stdout)
  } catch {
    return null
  }
}

/**
 * Connects a board to a GitHub repository. Only the project owner can create,
 * configure or remove the link: it publishes through their GitHub identity.
 */
export function registerBoardLinkRoutes(app: FastifyInstance, ctx: AppContext, board: BoardSync): void {
  const loadProject = (projectId: string, userId: string): ProjectRow => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project || (project.ownerId !== userId && project.visibility !== 'shared')) {
      throw notFound('project_not_found', 'Project not found.')
    }
    return project
  }
  const requireOwner = (project: ProjectRow, userId: string) => {
    if (project.ownerId !== userId) {
      throw forbidden('board_link_owner_only', 'Only the project owner can link the board.')
    }
  }

  const toDto = (projectId: string): BoardLinkDto | null => {
    const row = ctx.db
      .select({ link: boardLinks, userName: users.displayName })
      .from(boardLinks)
      .innerJoin(users, eq(users.id, boardLinks.userId))
      .where(eq(boardLinks.projectId, projectId))
      .get()
    if (!row) return null
    const { link } = row
    return {
      projectId,
      provider: link.provider,
      repo: link.repo,
      url: `https://github.com/${link.repo}`,
      labelFilter: link.labelFilter,
      closedDays: link.closedDays,
      newCards: link.newCards,
      progressLabel: link.progressLabel,
      reviewLabel: link.reviewLabel,
      onIssue: link.onIssue,
      issueInstructions: link.issueInstructions,
      onComment: link.onComment,
      commentInstructions: link.commentInstructions,
      commentDelivery: link.commentDelivery,
      replyStyle: link.replyStyle,
      identity: link.identity,
      signature: link.signature,
      sessionAgent: link.sessionAgent,
      sessionConfig: readSessionConfig(link.sessionConfig),
      workspace: link.workspace,
      maxSessionsPerHour: link.maxSessionsPerHour,
      decisionsEnabled: link.decisionsEnabled,
      decisionMaxHours: link.decisionMaxHours,
      userId: link.userId,
      userName: row.userName,
      hiddenCount: parseHidden(link.hiddenIssues).length,
      lastSyncedAt: link.lastSyncedAt,
      lastError: link.lastError,
      syncing: board.isSyncing(projectId),
    }
  }

  const state = async (project: ProjectRow, userId: string): Promise<BoardLinkStateDto> => ({
    link: toDto(project.id),
    suggestedRepo: await originRepo(project.workspacePath),
    hasCredential: board.hasCredential(userId),
  })

  app.get('/api/projects/:id/board-link', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    return state(loadProject(id, user.id), user.id)
  })

  /** Connects a board or changes settings; the repository itself stays fixed. */
  app.put('/api/projects/:id/board-link', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = loadProject(id, user.id)
    requireOwner(project, user.id)
    const { sessionConfig, ...parsed } = boardLinkSettingsSchema.parse(request.body)
    const settings = { ...parsed, sessionConfig: sessionConfig ? JSON.stringify(sessionConfig) : null }
    const existing = board.link(id)
    const now = Date.now()

    if (!existing) {
      await board.checkRepo(user.id, settings.repo)
      ctx.db
        .insert(boardLinks)
        .values({ projectId: id, provider: 'github', userId: user.id, ...settings, createdAt: now, updatedAt: now })
        .run()
    } else {
      if (existing.repo.toLowerCase() !== settings.repo.toLowerCase()) {
        throw conflict('board_repo_locked', 'Unlink the board before linking another repository.')
      }
      // A different filter or window changes eligible issues: reread from the start,
      // which only adds missing cards.
      const rescan = existing.labelFilter !== settings.labelFilter || existing.closedDays !== settings.closedDays
      ctx.db
        .update(boardLinks)
        .set({ ...settings, repo: existing.repo, updatedAt: now, ...(rescan ? { cursor: null, lastSyncedAt: null } : {}) })
        .where(eq(boardLinks.projectId, id))
        .run()
    }
    board.kick(id)
    void board.syncNow(id).catch(() => {})
    return state(project, user.id)
  })

  /**
   * Disconnects a board. GitHub cards without local work leave with the link
   * unless `?keep=1`; cards with local work remain as local cards.
   */
  app.delete('/api/projects/:id/board-link', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { keep } = request.query as { keep?: string }
    const project = loadProject(id, user.id)
    requireOwner(project, user.id)
    if (!board.link(id)) throw notFound('board_not_linked', 'This board is not linked to GitHub.')

    const linked = ctx.db
      .select({ cardId: cardIssues.cardId })
      .from(cardIssues)
      .where(and(eq(cardIssues.projectId, id), eq(cardIssues.detached, false)))
      .all()
      .map((row) => row.cardId)
    const removable = keep === '1' ? [] : linked.filter((cardId) => !hasLocalWork(ctx.db, cardId))

    writeTransaction(ctx.db, (tx) => {
      for (const cardId of removable) tx.delete(cards).where(eq(cards.id, cardId)).run()
      tx.update(cardIssues).set({ detached: true }).where(eq(cardIssues.projectId, id)).run()
      tx.delete(boardLinks).where(eq(boardLinks.projectId, id)).run()
    })
    return state(project, user.id)
  })

  app.post('/api/projects/:id/board-link/sync', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = loadProject(id, user.id)
    if (!board.link(id)) throw notFound('board_not_linked', 'This board is not linked to GitHub.')
    await board.syncNow(id)
    return state(project, user.id)
  })

  /** Manually removed issues return on the next pass. */
  app.post('/api/projects/:id/board-link/hidden/reset', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = loadProject(id, user.id)
    requireOwner(project, user.id)
    ctx.db
      .update(boardLinks)
      .set({ hiddenIssues: '[]', cursor: null, lastSyncedAt: null, updatedAt: Date.now() })
      .where(eq(boardLinks.projectId, id))
      .run()
    void board.syncNow(id).catch(() => {})
    return state(project, user.id)
  })
}
