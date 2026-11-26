import { continueInProject } from '../conversations/continue-in-project.js'
import { personalMemoryDir, writePersonalMemory } from '../memory/personal.js'
import { createProject } from '../projects/create.js'
import { attachProjectFolder } from '../projects/folders.js'
import { deleteProject } from '../projects/delete.js'
import { CROSS_PROJECTS_OFF, crossProjectsEnabled } from '../projects/cross-projects.js'
import { searchTree } from '../search/search-files.js'
import type { AttachmentStore } from '../attachments/store.js'
import type { TerminalManager } from '../terminals/terminal-manager.js'
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  agentRequests,
  apiTokens,
  conversations,
  projects,
  users,
  type AgentRequestRow,
  type ConversationRow,
} from '@sillage/db'
import {
  conversationPath,
  memoryFileSchema,
  openExplorerFolderBodySchema,
  renameSessionBodySchema,
  writeMemoryFileBodySchema,
} from '@sillage/protocol'
import type { ActionRunner } from '../actions/actions.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { EventLog } from '../events/event-log.js'
import { adoptSessionTitle } from '../conversations/title.js'
import type { AppContext } from '../http/context.js'
import { allowedProjectIds } from '../http/v1/access.js'
import { HttpError } from '../http/errors.js'
import type { BoardSync } from '../board/board-sync.js'
import { DecisionRefusal, type DecisionService } from '../decisions/service.js'
import { McpInstallRefusal, proposeMcpInstall } from '../agents/mcp-install.js'
import type { WorktreeCleanup } from '../worktrees/cleanup.js'
import type { WorktreeStatusService } from '../worktrees/status-service.js'
import type { SessionManager } from './session-manager.js'
import { detach } from '../detach.js'
import { ActionRequests } from './agent-requests-actions.js'
import { CardRequests } from './agent-requests-cards.js'
import { SessionLaunches } from './agent-requests-launch.js'
import { LaunchConfigs } from './agent-requests-models.js'
import { ScheduleRequests } from './agent-requests-schedules.js'
import { SessionOperations } from './agent-requests-sessions.js'
import { describeError, Refusal, type Requester } from './agent-requests-shared.js'
import { describePreview } from './agent-requests-previews.js'
import { WorktreeRequests } from './agent-requests-worktrees.js'

export { launchRefusal, MAX_LAUNCH_DEPTH, MAX_LAUNCH_PROMPT_CHARS } from './agent-requests-launch.js'
export { matchEffort, matchModel } from './agent-requests-models.js'
export { MAX_AGENT_SCHEDULES_PER_PROJECT, MIN_AGENT_SCHEDULE_MINUTES } from './agent-requests-schedules.js'

/** Handles MCP daemon requests: session launches, cards, scheduling and model catalogs. MCP only has database access, deposits requests and waits for this sweep to write results. Sweep faster than relays because agents await replies. Responses are model-facing English like other tools; errors explain corrections. Each request kind's work lives in a collaborator (`agent-requests-*.ts`); this class claims, routes and settles. */

const POLL_MS = 500

/** Ignore requests older than this: their MCP callers returned long ago, and launching sessions whose IDs nobody receives would be worse than doing nothing. */
const STALE_MS = 5 * 60 * 1000

/** Concurrent requests per daemon. Enough that sessions never queue behind one another in practice, low enough that a burst cannot launch dozens of CLIs at once. */
const MAX_IN_FLIGHT = 8

export class AgentRequests {
  private timer: NodeJS.Timeout | null = null
  private readonly inFlight = new Set<string>()
  private logger: FastifyBaseLogger | null = null
  private readonly configs: LaunchConfigs
  private readonly launches: SessionLaunches
  private readonly worktreeRequests: WorktreeRequests
  private readonly schedules: ScheduleRequests
  private readonly cards: CardRequests
  private readonly actionRequests: ActionRequests
  private readonly sessionOps: SessionOperations

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    registry: AgentRegistry,
    /** Optional in unrelated tests; absent means `run_action` is rejected. */
    actions?: ActionRunner,
    /** Webhook signing-secret key; absent means `create_automation` is rejected. */
    encryptionKey?: Buffer,
    /** GitHub board connection; absent keeps `create_card` local. */
    board?: BoardSync,
    /** Autonomous-session decisions; absent means `request_decision` is rejected. */
    private readonly decisions?: DecisionService,
    /** Journal for finding open requests resolved by `reply_session`. */
    private readonly log?: EventLog,
    /** Worktree progress; absent means `list_worktrees` is rejected. */
    worktreeStatus?: WorktreeStatusService,
    private readonly attachments?: AttachmentStore,
    private readonly terminals?: TerminalManager,
    /** Worktree cleanup; absent means `remove_worktree` is rejected. */
    worktreeCleanup?: WorktreeCleanup,
  ) {
    this.configs = new LaunchConfigs(ctx, registry, sessions)
    this.launches = new SessionLaunches(ctx, sessions, this.configs, worktreeStatus)
    this.worktreeRequests = new WorktreeRequests(ctx, worktreeStatus, worktreeCleanup)
    this.schedules = new ScheduleRequests(ctx, this.configs, encryptionKey)
    this.cards = new CardRequests(ctx, sessions, board)
    this.actionRequests = new ActionRequests(ctx, actions)
    this.sessionOps = new SessionOperations(ctx, sessions, log)
  }

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    this.closeInterrupted()
    this.timer = setInterval(() => detach(this.sweep(), 'agent request pass'), POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Requests run concurrently, bounded by `MAX_IN_FLIGHT`. Sequential handling let one slow
   * request (a cold model catalog, a CLI slow to boot on Windows) hold every other session's
   * request past its MCP wait, so callers saw “Sillage did not respond” while nothing was wrong
   * with the service. Each sweep awaits only the requests it started, so tests driving `sweep()`
   * still observe their own request settled.
   */
  async sweep(): Promise<void> {
    // Runs from a timer: a failure (a busy database, a project move that throws) is logged and
    // retried at the next poll, never left to reject.
    try {
      await this.sweepOnce()
    } catch (err) {
      this.logger?.error({ err }, 'agent request sweep failed')
    }
  }

  private async sweepOnce(): Promise<void> {
    await this.sessions.applyPendingProjectMoves?.()
    const room = MAX_IN_FLIGHT - this.inFlight.size
    if (room <= 0) return
    const pending = this.ctx.db
      .select()
      .from(agentRequests)
      .where(and(isNull(agentRequests.settledAt), isNull(agentRequests.claimedAt)))
      .orderBy(asc(agentRequests.createdAt))
      .limit(20)
      .all()
      .filter((request) => !this.inFlight.has(request.id))

    const started: Promise<void>[] = []
    for (const request of pending) {
      if (request.createdAt < Date.now() - STALE_MS) {
        this.settle(request.id, 'Request expired: Sillage did not process it in time.', true)
        continue
      }
      if (started.length >= room) break
      // Claim before any effect, and only if the caller has not cancelled meanwhile.
      if (!this.claim(request.id)) continue
      this.inFlight.add(request.id)
      started.push(this.handle(request).finally(() => this.inFlight.delete(request.id)))
    }
    await Promise.all(started)
  }

  private claim(id: string): boolean {
    return this.ctx.db
      .update(agentRequests)
      .set({ claimedAt: Date.now() })
      .where(and(eq(agentRequests.id, id), isNull(agentRequests.settledAt), isNull(agentRequests.claimedAt)))
      .run().changes === 1
  }

  /**
   * Requests a previous daemon claimed and never settled: it stopped while handling them. Their
   * effects may already exist (a session started, an issue published), so running them again
   * would duplicate them for a caller long gone. Close them, saying what to check.
   */
  private closeInterrupted(): void {
    const closed = this.ctx.db
      .update(agentRequests)
      .set({
        settledAt: Date.now(),
        isError: true,
        result: 'Interrupted: Sillage restarted while handling this request, which may have partly taken effect. Check the result (list_sessions, list_cards…) before submitting it again.',
      })
      .where(and(isNull(agentRequests.settledAt), isNotNull(agentRequests.claimedAt)))
      .run().changes
    if (closed > 0) this.logger?.warn({ closed }, 'agent requests interrupted by the previous shutdown')
  }

  private async handle(request: AgentRequestRow): Promise<void> {
    try {
      const payload = JSON.parse(request.payload) as Record<string, unknown>
      const conversation = request.conversationId
        ? this.ctx.db.select().from(conversations).where(eq(conversations.id, request.conversationId)).get()
        : null
      if (request.conversationId && !conversation) throw new Refusal('The requesting session no longer exists.')
      // A project session acts in its own project unless that project lets its sessions reach the
      // account's other projects; the target's own access check below still applies.
      if (conversation?.projectId && conversation.projectId !== request.projectId && !crossProjectsEnabled(this.ctx.db, conversation.projectId)) {
        throw new Refusal(CROSS_PROJECTS_OFF)
      }
      if (conversation && request.userId && request.userId !== conversation.userId) throw new Refusal('The request account does not match its session.')
      const userId = conversation?.userId ?? request.userId
      const user = userId ? this.ctx.db.select().from(users).where(eq(users.id, userId)).get() : undefined
      if (!userId || !user) throw new Refusal('The requesting account no longer exists.')

      if (request.kind === 'rename_session') {
        if (!conversation) throw new Refusal('This tool only renames your own session.')
        const { title } = renameSessionBodySchema.parse(payload)
        const result = adoptSessionTitle(this.ctx.db, this.sessions.statusBus, conversation.id, title, 'agent')
        this.settle(request.id, result === 'protected' ? 'The user chose the title; it is preserved.' : `Your session title: “${title}”.`, false)
        return
      }
      if (request.kind === 'describe_preview') {
        if (!conversation) throw new Refusal('This tool only presents dev servers your own session started.')
        this.settle(request.id, await describePreview(this.ctx, conversation, user, payload), false)
        return
      }
      if (request.kind === 'move_session') {
        if (!conversation || !conversation.projectId) throw new Refusal('This tool moves your own project session only.')
        const target = typeof payload.project === 'string' ? payload.project.trim() : ''
        if (!target) throw new Refusal('Provide the exact destination project name or ID.')
        const moved = await this.sessions.moveToProject(conversation.id, userId, target)
        this.settle(request.id, moved.pending
          ? `Move to “${moved.projectName}” scheduled. Finish this turn now; Sillage moves this same session when the turn and background work finish. The full journal is retained. No files or project memory are moved. Do not create a replacement session.`
          : `This same session now belongs to “${moved.projectName}”. History is retained. The next turn uses its directory and instructions.`, false)
        return
      }
      if (request.kind === 'write_personal_memory' || request.kind === 'delete_personal_memory') {
        if (!conversation || conversation.projectId !== null) throw new Refusal('Personal memory requires a personal discussion.')
        const file = memoryFileSchema.parse(payload.file)
        const content = request.kind === 'delete_personal_memory' ? null : writeMemoryFileBodySchema.parse(payload).content
        await writePersonalMemory(this.ctx.db, personalMemoryDir(this.ctx.config.paths.memory, userId), userId, file, content, conversation.id)
        this.settle(request.id, `Personal memory updated: ${file}. The change is visible and editable in Sillage.`, false)
        return
      }
      if (request.kind === 'create_project' || request.kind === 'continue_in_project') {
        if (!conversation || conversation.projectId !== null) throw new Refusal('This action requires a personal discussion.')
        if (request.kind === 'continue_in_project') {
          const result = await continueInProject(this.ctx, this.sessions, conversation, userId, payload)
          this.settle(request.id, `Project “${result.project.name}” created at ${result.project.workspacePath}. Continue in session:${result.conversation.id} (${conversationPath(result.conversation)}). The brief is saved and visible there. ${payload.prompt ? 'The requested first turn has been sent.' : 'The session is ready: use message_session with this ID to begin the next action; do not create a second continuation.'} This discussion stays personal and its original files are preserved.`, false, result.conversation.id)
        } else {
          const project = await createProject(this.ctx, userId, payload)
          this.settle(request.id, `Project “${project.name}” created: ${project.id}, ${project.workspacePath}.`, false)
        }
        return
      }
      if (request.kind === 'find_files') {
        if (!conversation || conversation.projectId !== null) throw new Refusal('This action requires a personal discussion.')
        const query = typeof payload.query === 'string' ? payload.query.trim() : ''
        if (query.length < 2) throw new Refusal('Provide at least two characters to search for.')
        const accessible = this.ctx.db.select().from(projects).all().filter(project => (project.ownerId === userId || project.visibility === 'shared') && (!request.projectId || project.id === request.projectId))
        const results = []
        for (const project of accessible.slice(0, 30)) {
          const found = await searchTree(project.workspacePath, query)
          results.push({ project: project.name, directory: project.workspacePath, ...found })
        }
        this.settle(request.id, JSON.stringify({ results, truncated: accessible.length > 30, hint: 'These are accessible Sillage project folders. Use native CLI file tools to search elsewhere as requested and permitted.' }), false)
        return
      }
      if (request.kind === 'list_models' && conversation?.projectId === null && !request.projectId) {
        this.settle(request.id, await this.configs.listModels(conversation, null, payload), false)
        return
      }
      if (!request.projectId) throw new Refusal('Select a target project for this action.')
      const project = this.ctx.db.select().from(projects).where(eq(projects.id, request.projectId)).get()
      if (!project || (project.ownerId !== userId && project.visibility !== 'shared')) throw new Refusal('The target project is unavailable to this account.')
      // An archived project is dormant: the scheduler, automations and the API leave it alone, and
      // so do other sessions. A session inside it keeps working there, since archiving did not stop it.
      if (project.archivedAt !== null && conversation?.projectId !== project.id) {
        throw new Refusal(`Project “${project.name}” is archived. The user can unarchive it in Sillage before you act on it.`)
      }
      const requester: Requester = conversation
        ? {
            ...conversation,
            projectId: project.id,
            personal: conversation.projectId === null,
            worktreeId: conversation.projectId === project.id ? conversation.worktreeId : null,
            // Named in what it starts or signs there, so the other project's sessions know where it comes from.
            fromProject: conversation.projectId && conversation.projectId !== project.id
              ? this.ctx.db.select({ name: projects.name }).from(projects).where(eq(projects.id, conversation.projectId)).get()?.name
              : undefined,
          }
        : this.principal(request, project.id, payload)
      if (request.kind === 'delete_project') {
        if (!conversation || conversation.projectId !== null || !this.attachments || !this.terminals) throw new Refusal('Project deletion is unavailable here.')
        // The project's cascade must not erase this request before the caller reads its result.
        this.ctx.db.update(agentRequests).set({ projectId: null }).where(eq(agentRequests.id, request.id)).run()
        await deleteProject(this.ctx, project.id, userId, this.attachments, this.terminals, this.sessions)
        this.settle(request.id, `Project “${project.name}” removed from Sillage. Its directory is preserved: ${project.workspacePath}.`, false)
        return
      }

      if (request.kind === 'attach_project_folder') {
        if (conversation?.projectId !== project.id) throw new Refusal('A project session can attach folders to its own project.')
        const { path } = openExplorerFolderBodySchema.parse(payload)
        const folder = await attachProjectFolder(this.ctx, user, project.id, path)
        this.sessions.statusBus.emit('lists')
        this.settle(request.id, `Available in the Files menu for all members of “${project.name}”: ${folder.path}`, false)
        return
      }
      if (request.kind === 'start_session') {
        const { text, launchedId } = await this.launches.startSession(request, requester, project, payload)
        this.settle(request.id, text, false, launchedId)
      } else if (request.kind === 'schedule_task') {
        this.settle(request.id, await this.schedules.scheduleTask(requester, project, payload), false)
      } else if (request.kind === 'request_decision' || request.kind === 'withdraw_decision') {
        // Decisions require autonomous session identities: without sessions, none.
        if (!conversation) throw new Refusal('This tool is only for autonomous sessions: there is no decision to request outside a session.')
        this.settle(request.id, await this.decide(request.kind, conversation, payload), false)
      } else if (request.kind === 'install_mcp_server') {
        // The proposal is posted in the requesting conversation, so a sessionless client has nowhere to show it.
        if (!conversation || !this.log) throw new Refusal('This tool is only available from a Sillage session.')
        try {
          const proposal = proposeMcpInstall(this.ctx.db, this.log, conversation, payload)
          this.settle(request.id, proposal.text, false)
          // Appended outside a runner, so the usual emit path did not notify an absent user.
          this.sessions.notifyRequest(conversation.id, proposal.event)
        } catch (err) {
          if (err instanceof McpInstallRefusal) throw new Refusal(err.message)
          throw err
        }
      } else if (request.kind === 'link_cards' || request.kind === 'unlink_cards') {
        this.settle(request.id, this.cards.link(request.kind, requester, payload), false)
      } else if (request.kind === 'attach_card' || request.kind === 'detach_card') {
        this.settle(request.id, this.cards.attach(request.kind, requester, payload), false)
      } else if (request.kind === 'update_card') {
        this.settle(request.id, this.cards.update(requester, payload), false)
      } else if (request.kind === 'create_card') {
        this.settle(request.id, await this.cards.create(requester, payload), false)
      } else if (request.kind === 'register_action') {
        this.settle(request.id, this.actionRequests.register(requester, payload), false)
      } else if (request.kind === 'remove_action') {
        this.settle(request.id, await this.actionRequests.remove(requester, payload), false)
      } else if (request.kind === 'create_automation') {
        this.settle(request.id, await this.schedules.createAutomation(requester, project, payload), false)
      } else if (request.kind === 'run_action') {
        this.settle(request.id, await this.actionRequests.run(requester, payload), false)
      } else if (request.kind === 'create_worktree') {
        this.settle(request.id, await this.worktreeRequests.create(requester, project, payload), false)
      } else if (request.kind === 'list_worktrees') {
        this.settle(request.id, await this.worktreeRequests.list(requester, project), false)
      } else if (request.kind === 'remove_worktree') {
        this.settle(request.id, await this.worktreeRequests.remove(requester, project, payload), false)
      } else if (
        request.kind === 'message_session' ||
        request.kind === 'steer_session' ||
        request.kind === 'interrupt_session' ||
        request.kind === 'reply_session'
      ) {
        this.settle(request.id, await this.sessionOps.actOnSession(request.kind, requester, payload), false)
      } else if (request.kind === 'list_models') {
        this.settle(request.id, await this.configs.listModels(requester, project, payload), false)
      } else {
        // Written by `sillage-mcp.mjs`, outside the type graph, or by another daemon version: an
        // unknown kind says so. It used to fall through to the model catalog, which read as a
        // tool silently returning the wrong answer. `webhook_launch` rows are written settled by the
        // scheduler and never come here; a new kind without a branch above fails to compile.
        const unhandled: 'webhook_launch' = request.kind
        throw new Refusal(`Sillage does not handle “${String(unhandled)}” requests. It may need updating.`)
      }
    } catch (err) {
      if (!(err instanceof Refusal) && !(err instanceof HttpError)) {
        this.logger?.warn({ err, request: request.id, kind: request.kind }, 'agent request failed')
      }
      this.settle(request.id, describeError(err), true)
    }
  }

  /** Sessionless requester account named in the request. Default CLI is Claude like new interface projects; global clients specify `agent` for another, as descriptions explain. */
  private principal(request: AgentRequestRow, projectId: string, payload: Record<string, unknown>): Requester {
    if (!request.userId) throw new Refusal('The request has no session or account: Sillage does not know whom to act for.')
    const user = this.ctx.db.select().from(users).where(eq(users.id, request.userId)).get()
    if (!user) throw new Refusal('The account to act for no longer exists.')
    const tokenId = payload.__apiTokenId
    const token = typeof tokenId === 'string' ? this.ctx.db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get() : undefined
    if (tokenId !== undefined) {
      if (!token || token.userId !== user.id || token.revokedAt !== null || (token.expiresAt !== null && token.expiresAt <= Date.now())) {
        throw new Refusal('The API token is no longer valid.')
      }
      const allowed = allowedProjectIds(token)
      const project = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project || project.archivedAt !== null || (project.ownerId !== user.id && project.visibility !== 'shared') ||
        (allowed.length > 0 && !allowed.includes(project.id))) throw new Refusal('The API token cannot access this project.')
    }

    return {
      id: '',
      projectId,
      userId: user.id,
      agent: token?.agent ?? 'claude',
      apiToken: token,
      worktreeId: null,
      scheduleId: null,
      title: user.displayName,
    }
  }

  private settle(id: string, result: string, isError: boolean, launchedId: string | null = null): void {
    this.ctx.db
      .update(agentRequests)
      .set({ settledAt: Date.now(), result, isError, launchedConversationId: launchedId })
      .where(eq(agentRequests.id, id))
      .run()
  }

  // --- request_decision / withdraw_decision --------------------------------------

  private async decide(kind: 'request_decision' | 'withdraw_decision', requester: ConversationRow, payload: Record<string, unknown>): Promise<string> {
    if (!this.decisions) throw new Refusal('Decisions are unavailable on this server.')
    try {
      return kind === 'request_decision' ? await this.decisions.request(requester, payload) : this.decisions.withdraw(requester, payload)
    } catch (err) {
      if (err instanceof DecisionRefusal) throw new Refusal(err.message)
      throw err
    }
  }
}
