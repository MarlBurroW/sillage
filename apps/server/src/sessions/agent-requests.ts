import { continueInProject } from '../conversations/continue-in-project.js'
import { resolveAgentTags, setCardTags, TagRefusal, type TagAuthor } from '../board/card-tags.js'
import { personalMemoryDir, writePersonalMemory } from '../memory/personal.js'
import { createProject } from '../projects/create.js'
import { deleteProject } from '../projects/delete.js'
import { searchEntries } from '../workspace.js'
import type { AttachmentStore } from '../attachments/store.js'
import type { TerminalManager } from '../terminals/terminal-manager.js'
import { memoryFileSchema, writeMemoryFileBodySchema, conversationPath } from '@sillage/protocol'
import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { and, asc, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  agentRequests,
  apiTokens,
  type ApiTokenRow,
  cardNotes,
  conversationPaths,
  cards,
  conversations,
  projects,
  scheduledTasks,
  users,
  worktrees,
  type AgentRequestRow,
  type ConversationRow,
  type ProjectRow,
} from '@sillage/db'
import {
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  EFFORT_FIELD,
  DEFAULT_SCHEDULE_DURATION_MINUTES,
  MAX_CHECK_SCRIPT_CHARS,
  MAX_CHECK_TIMEOUT_SECONDS,
  MIN_CHECK_TIMEOUT_SECONDS,
  checkScriptSchema,
  checkTimeoutSchema,
  MAX_SCHEDULE_DURATION_MINUTES,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULE_PROMPT_CHARS,
  MIN_SCHEDULE_DURATION_MINUTES,
  AUTOMATION_TEMPLATES,
  agentConfigSchema,
  automationConditionsSchema,
  taskReplyBodySchema,
  renameSessionBodySchema,
  createProjectActionBodySchema,
  updateProjectActionBodySchema,
  updateCardBodySchema,
  createCardRelationBodySchema,
  agentKindSchema,
  defaultConfigFor,
  formatSessionMessage,
  readProjectDefaults,
  scheduleCadenceSchema,
  type ScheduleCadence,
  type AgentConfig,
  type AgentKind,
  type AgentModelDto,
  type DeliveryReason,
  type ProjectActionRunResult,
  type WebhookSettings,
  type WebhookVerification,
} from '@sillage/protocol'
import type { ZodError } from 'zod'
import {
  createAction,
  deleteAction,
  loadAction,
  updateAction,
  type ActionRunner,
} from '../actions/actions.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { EventLog } from '../events/event-log.js'
import { createWebhook, readSettings, revealSecret, webhookUrl } from '../automations/webhooks.js'
import { createConversation } from '../conversations/create.js'
import { adoptSessionTitle } from '../conversations/title.js'
import type { AppContext } from '../http/context.js'
import { readExecutionPolicy } from '../auth/api-tokens.js'
import { allowedProjectIds } from '../http/v1/access.js'
import { allowedModels, assertAgentAllowed, assertTokenExecution } from '../http/v1/execution-policy.js'
import { resolveTaskConfig } from '../http/v1/config.js'
import { HttpError } from '../http/errors.js'
import { advanceCardOnLaunch, createCard, updateCard } from '../http/routes/cards.js'
import { linkCards, unlinkCards } from '../board/card-relations.js'
import type { BoardSync } from '../board/board-sync.js'
import { DecisionRefusal, type DecisionService } from '../decisions/service.js'
import { createWorktree } from '../http/routes/worktrees.js'
import { defaultBase } from '../worktrees/assess.js'
import type { WorktreeCleanup } from '../worktrees/cleanup.js'
import type { WorktreeStatusService } from '../worktrees/status-service.js'
import { createScheduledTask } from '../scheduler/tasks.js'
import { readUserSettings } from '../settings/user-settings.js'
import { resolveConversationCwd } from '../workspace.js'
import type { SessionManager } from './session-manager.js'

/** Handles MCP daemon requests: session launches, cards, scheduling and model catalogs. MCP only has database access, deposits requests and waits for this sweep to write results. Sweep faster than relays because agents await replies. Responses are model-facing English like other tools; errors explain corrections. */

const POLL_MS = 500

/** Ignore requests older than this: their MCP callers returned long ago, and launching sessions whose IDs nobody receives would be worse than doing nothing. */
const STALE_MS = 5 * 60 * 1000

/** Maximum launch-chain depth: human sessions launch one session, which may launch one final session. Further levels drift from human oversight and create unintended swarms. */
export const MAX_LAUNCH_DEPTH = 2

/** Successful launches per session per hour. */
export const LAUNCHES_PER_HOUR = 6

/** Longer missions belong in files referenced by mission prompts. */
export const MAX_LAUNCH_PROMPT_CHARS = 20000

const HOUR_MS = 60 * 60 * 1000

/** Minimum agent-created schedule interval. Interfaces allow tighter intervals because humans choose them; misunderstood per-minute tasks could consume quotas before discovery. */
export const MIN_AGENT_SCHEDULE_MINUTES = 15

/** Per-project task cap beyond which agents cannot add more. */
export const MAX_AGENT_SCHEDULES_PER_PROJECT = 20

/** Interpolates HTTP error `{param}` placeholders because shared route errors are API-oriented but models read them verbatim. */
function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    return err.message.replace(/\{(\w+)\}/g, (_, key: string) => String(err.params?.[key] ?? key))
  }
  return err instanceof Error ? err.message : String(err)
}

class Refusal extends Error {}

/** Must match protocol `createWorktreeBodySchema`: names also become directories. */
function assertWorktreeName(name: string): void {
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

/** Requester is a session or an account without sessions. Global MCP local clients (`docs/mcp.md`) supply `user_id` instead of conversations, with empty `id`, no worktree/task ancestry and no session-specific launch chains, provenance notes or decisions. Use `Pick` rather than whole rows so types expose only fields actually read. */
type Requester = Pick<ConversationRow, 'id' | 'userId' | 'agent' | 'worktreeId' | 'scheduleId' | 'title'> & { projectId: string; personal?: boolean; apiToken?: ApiTokenRow }

interface StartSessionPayload {
  prompt?: unknown
  title?: unknown
  agent?: unknown
  model?: unknown
  effort?: unknown
  worktree?: unknown
  card?: unknown
}

export class AgentRequests {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private logger: FastifyBaseLogger | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    private readonly registry: AgentRegistry,
    /** Optional in unrelated tests; absent means `run_action` is rejected. */
    private readonly actions?: ActionRunner,
    /** Webhook signing-secret key; absent means `create_automation` is rejected. */
    private readonly encryptionKey?: Buffer,
    /** GitHub board connection; absent keeps `create_card` local. */
    private readonly board?: BoardSync,
    /** Autonomous-session decisions; absent means `request_decision` is rejected. */
    private readonly decisions?: DecisionService,
    /** Journal for finding open requests resolved by `reply_session`. */
    private readonly log?: EventLog,
    /** Worktree progress; absent means `list_worktrees` is rejected. */
    private readonly worktreeStatus?: WorktreeStatusService,
    private readonly attachments?: AttachmentStore,
    private readonly terminals?: TerminalManager,
    /** Worktree cleanup; absent means `remove_worktree` is rejected. */
    private readonly worktreeCleanup?: WorktreeCleanup,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    this.timer = setInterval(() => void this.sweep(), POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async sweep(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const pending = this.ctx.db
        .select()
        .from(agentRequests)
        .where(isNull(agentRequests.settledAt))
        .orderBy(asc(agentRequests.createdAt))
        .limit(20)
        .all()

      for (const request of pending) {
        if (request.createdAt < Date.now() - STALE_MS) {
          this.settle(request.id, 'Request expired: Sillage did not process it in time.', true)
          continue
        }
        await this.handle(request)
      }
    } finally {
      this.busy = false
    }
  }

  private async handle(request: AgentRequestRow): Promise<void> {
    try {
      const payload = JSON.parse(request.payload) as Record<string, unknown>
      const conversation = request.conversationId
        ? this.ctx.db.select().from(conversations).where(eq(conversations.id, request.conversationId)).get()
        : null
      if (request.conversationId && !conversation) throw new Refusal('The requesting session no longer exists.')
      if (conversation?.projectId && conversation.projectId !== request.projectId) throw new Refusal('The target must belong to the requesting project session.')
      if (conversation && request.userId && request.userId !== conversation.userId) throw new Refusal('The request account does not match its session.')
      const userId = conversation?.userId ?? request.userId
      if (!userId || !this.ctx.db.select().from(users).where(eq(users.id, userId)).get()) throw new Refusal('The requesting account no longer exists.')

      if (request.kind === 'rename_session') {
        if (!conversation) throw new Refusal('This tool only renames your own session.')
        const { title } = renameSessionBodySchema.parse(payload)
        const result = adoptSessionTitle(this.ctx.db, this.sessions.statusBus, conversation.id, title, 'agent')
        this.settle(request.id, result === 'protected' ? 'The user chose the title; it is preserved.' : `Your session title: “${title}”.`, false)
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
          const found = await searchEntries(project.workspacePath, query)
          results.push({ project: project.name, directory: project.workspacePath, ...found })
        }
        this.settle(request.id, JSON.stringify({ results, truncated: accessible.length > 30, hint: 'These are accessible Sillage project folders. Use native CLI file tools to search elsewhere as requested and permitted.' }), false)
        return
      }
      if (request.kind === 'list_models' && conversation?.projectId === null && !request.projectId) {
        this.settle(request.id, await this.listModels(conversation, null, payload), false)
        return
      }
      if (!request.projectId) throw new Refusal('Select a target project for this action.')
      const project = this.ctx.db.select().from(projects).where(eq(projects.id, request.projectId)).get()
      if (!project || (project.ownerId !== userId && project.visibility !== 'shared')) throw new Refusal('The target project is unavailable to this account.')
      const requester: Requester = conversation
        ? { ...conversation, projectId: project.id, personal: conversation.projectId === null, worktreeId: conversation.projectId === project.id ? conversation.worktreeId : null }
        : this.principal(request, project.id, payload)
      if (request.kind === 'delete_project') {
        if (!conversation || conversation.projectId !== null || !this.attachments || !this.terminals) throw new Refusal('Project deletion is unavailable here.')
        // The project's cascade must not erase this request before the caller reads its result.
        this.ctx.db.update(agentRequests).set({ projectId: null }).where(eq(agentRequests.id, request.id)).run()
        await deleteProject(this.ctx, project.id, userId, this.attachments, this.terminals, this.sessions)
        this.settle(request.id, `Project “${project.name}” removed from Sillage. Its directory is preserved: ${project.workspacePath}.`, false)
        return
      }

      if (request.kind === 'start_session') {
        const { text, launchedId } = await this.startSession(request, requester, project, payload)
        this.settle(request.id, text, false, launchedId)
      } else if (request.kind === 'schedule_task') {
        this.settle(request.id, await this.scheduleTask(requester, project, payload), false)
      } else if (request.kind === 'request_decision' || request.kind === 'withdraw_decision') {
        // Decisions require autonomous session identities: without sessions, none.
        if (!conversation) throw new Refusal('This tool is only for autonomous sessions: there is no decision to request outside a session.')
        this.settle(request.id, await this.decide(request.kind, conversation, payload), false)
      } else if (request.kind === 'link_cards' || request.kind === 'unlink_cards') {
        if (!Number.isInteger(payload.number)) throw new Refusal('The card number is required.')
        const { target, kind } = createCardRelationBodySchema.parse(payload)
        const change = request.kind === 'link_cards' ? linkCards : unlinkCards
        change(this.ctx.db, requester.projectId, payload.number as number, target, kind)
        this.settle(request.id, request.kind === 'link_cards' ? 'Relation added.' : 'Relation removed.', false)
      } else if (request.kind === 'attach_card' || request.kind === 'detach_card') {
        this.settle(request.id, this.attachCard(request.kind, requester, payload), false)
      } else if (request.kind === 'update_card') {
        this.settle(request.id, this.updateCard(requester, payload), false)
      } else if (request.kind === 'create_card') {
        this.settle(request.id, await this.createCard(requester, payload), false)
      } else if (request.kind === 'register_action') {
        this.settle(request.id, this.registerAction(requester, payload), false)
      } else if (request.kind === 'remove_action') {
        this.settle(request.id, await this.removeAction(requester, payload), false)
      } else if (request.kind === 'create_automation') {
        this.settle(request.id, await this.createAutomation(requester, project, payload), false)
      } else if (request.kind === 'run_action') {
        this.settle(request.id, await this.runAction(requester, payload), false)
      } else if (request.kind === 'create_worktree') {
        this.settle(request.id, await this.createWorktreeFor(requester, project, payload), false)
      } else if (request.kind === 'list_worktrees') {
        this.settle(request.id, await this.listWorktrees(requester, project), false)
      } else if (request.kind === 'remove_worktree') {
        this.settle(request.id, await this.removeWorktreeFor(requester, project, payload), false)
      } else if (
        request.kind === 'message_session' ||
        request.kind === 'steer_session' ||
        request.kind === 'interrupt_session' ||
        request.kind === 'reply_session'
      ) {
        this.settle(request.id, await this.actOnSession(request.kind, requester, payload), false)
      } else {
        this.settle(request.id, await this.listModels(requester, project, payload), false)
      }
    } catch (err) {
      if (!(err instanceof Refusal) && !(err instanceof HttpError)) {
        this.logger?.warn({ err, request: request.id, kind: request.kind }, 'demande d’agent en échec')
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

  // --- start_session -------------------------------------------------------------

  private async startSession(
    request: AgentRequestRow,
    requester: Requester,
    project: ProjectRow,
    payload: StartSessionPayload,
  ): Promise<{ text: string; launchedId: string }> {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) throw new Refusal('The `prompt` parameter is required: the new session\'s mission.')
    if (prompt.length > MAX_LAUNCH_PROMPT_CHARS) {
      throw new Refusal(
        `Mission too long (${prompt.length} characters, maximum ${MAX_LAUNCH_PROMPT_CHARS}). Put details in a file and cite it.`,
      )
    }

    this.assertLaunchAllowed(requester, request.id)

    const agent = this.parseAgent(payload.agent, requester.agent)
    const config = await this.launchConfig(agent, project, requester.userId, payload, requester.apiToken)
    const worktreeId = await this.launchTree(requester, project, payload.worktree)
    const card = this.launchCard(project.id, payload.card)
    const title =
      typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 200) : undefined

    const row = await createConversation(this.ctx.db, this.sessions, {
      projectId: project.id,
      userId: requester.userId,
      agent,
      config,
      worktreeId,
      cardId: card?.id ?? null,
      title,
      titleSource: prompt,
      origin: requester.apiToken ? { tokenId: requester.apiToken.id, label: requester.apiToken.label } : null,
      firstMessage: {
        clientMessageId: randomUUID(),
        // Account-launched missions arrive bare like user input,
        // without provenance notes referencing nonexistent sessions.
        text: requester.id
          ? formatSessionMessage({
              kind: 'launch',
              from: requester.id,
              title: requester.title,
              agent: requester.agent,
              messageId: request.id,
              body: prompt,
            })
          : prompt,
        attachments: [],
        mentions: [],
        skills: [],
      },
    })
    if (card) advanceCardOnLaunch(this.ctx, card.id)

    const tree = worktreeId
      ? (this.ctx.db.select({ name: worktrees.name }).from(worktrees).where(eq(worktrees.id, worktreeId)).get()
          ?.name ?? worktreeId)
      : null
    const lines = [
      `Session started: “${row.title}”, id ${row.id}.`,
      `CLI ${agent}, model ${describeModel(config)}, effort ${describeEffort(config)}.`,
      tree ? `Working in worktree “${tree}”.` : 'Working at the project root.',
      card ? `Attached to card #${card.number} “${card.title}”.` : null,
      describePermissions(config),
      requester.personal || !requester.id
        ? 'The user sees it in Sillage. Use read_session or wait_for_session for progress, and interrupt_session to stop its turn. Reuse this ID to continue the mission.'
        : 'The user sees it in Sillage. To be notified when it finishes, call notify_when_done with this ID, then end your turn if you have no independent work.',
    ]
    return { text: lines.filter(Boolean).join('\n'), launchedId: row.id }
  }

  /** Launch depth and rate safeguards. Walk ancestry through requests retaining created session IDs, avoiding conversation columns needed solely by this module. */
  private assertLaunchAllowed(requester: Requester, requestId: string): void {
    const refusal = launchRefusal(this.ctx.db, requester.id, requestId)
    if (refusal) throw new Refusal(refusal.message)
  }

  private parseAgent(value: unknown, fallback: AgentKind): AgentKind {
    if (value === undefined || value === null || value === '') return fallback
    const parsed = agentKindSchema.safeParse(typeof value === 'string' ? value.toLowerCase() : value)
    if (!parsed.success) {
      throw new Refusal(`Unknown CLI “${String(value)}”. Available values: ${agentKindSchema.options.join(', ')}.`)
    }
    return parsed.data
  }

  /** Launched-session configuration matches interface proposals: project presets then account defaults for the selected CLI, overridden by requested model and effort. Agents cannot change other settings, especially permissions; delegated sessions gain no more latitude than human one-click launches. */
  private async launchConfig(
    agent: AgentKind,
    project: ProjectRow | null,
    userId: string,
    payload: StartSessionPayload,
    token?: ApiTokenRow,
  ): Promise<AgentConfig> {
    if (token) {
      if (!project) throw new Refusal('Select a target project for this API token.')
      const override: Record<string, unknown> = {}
      if (payload.model !== undefined) override.model = payload.model
      if (payload.effort !== undefined) override[EFFORT_FIELD[agent]] = payload.effort
      return (await resolveTaskConfig(this.registry, token, project, {
        prompt: '', agent, config: override, worktreeId: null,
      }, readUserSettings(this.ctx.db, userId).agentDefaults, (config) => this.sessions.modelsFor(userId, config))).config
    }
    const base =
      readProjectDefaults(project?.defaultConfig ?? null)[agent] ??
      readUserSettings(this.ctx.db, userId).agentDefaults[agent] ??
      defaultConfigFor(agent)

    const requestedModel = typeof payload.model === 'string' ? payload.model.trim() : ''
    const requestedEffort = typeof payload.effort === 'string' ? payload.effort.trim().toLowerCase() : ''
    if (!requestedModel && !requestedEffort) {
      return this.registry.adapter(agent).resolveDefaults(base)
    }

    const catalog = await this.sessions.modelsFor(userId, base)
      .then((listing) => listing.models)
      .catch((): AgentModelDto[] => [])

    let config: AgentConfig = { ...base }
    if (requestedModel) {
      const model = matchModel(catalog, requestedModel)
      if (!model && catalog.length > 0) {
        throw new Refusal(
          `Unknown model “${requestedModel}” for ${agent}. Available: ${catalog.map(nameModel).join(', ')}.`,
        )
      }
      config = { ...config, model: model?.value ?? requestedModel }
    }

    // Effective model after defaults resolution determines which
    // effort levels are available.
    config = await this.registry.adapter(agent).resolveDefaults(config)

    const model = catalog.find((entry) => entry.value === config.model) ?? catalog.find((entry) => entry.isDefault)
    const efforts = model?.efforts.map((entry) => entry.value) ?? []
    const current = effortOf(config)
    if (!requestedEffort && model?.defaultEffort && efforts.length > 0 && !efforts.includes(current)) {
      // Requested models use their own default effort rather than inherited defaults,
      // matching interface selection and avoiding invalid launches.
      config = withEffort(config, model.defaultEffort)
    }

    if (requestedEffort) {
      const effort = matchEffort(efforts, requestedEffort)
      if (!effort) {
        throw new Refusal(
          efforts.length === 0
            ? `Model ${config.model} does not support effort settings: omit \`effort\`.`
            : `Unknown effort “${requestedEffort}” for ${config.model}. Levels: ${efforts.join(', ')}.`,
        )
      }
      config = withEffort(config, effort)
    }

    const parsed = agentConfigSchema.safeParse(config)
    if (!parsed.success) throw new Refusal(`Configuration refused: ${parsed.error.issues[0]?.message ?? 'invalid'}.`)
    return parsed.data
  }

  /** Launched-session working location. Default to the launcher's tree for 'continue this elsewhere'. Unrelated bugs often deserve named worktrees; `@root` selects project roots. */
  private async launchTree(
    requester: Requester,
    project: ProjectRow,
    value: unknown,
  ): Promise<string | null> {
    if (value === undefined || value === null || value === '') return requester.worktreeId
    if (typeof value !== 'string') throw new Refusal('The `worktree` parameter must be a string.')
    const name = value.trim()
    if (name === '@root') return null

    const existing = this.ctx.db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(and(eq(worktrees.projectId, project.id), eq(worktrees.name, name), isNull(worktrees.removedAt)))
      .get()
    if (existing) return existing.id

    assertWorktreeName(name)
    const row = await createWorktree(this.ctx, project, requester.userId, name, 'HEAD')
    this.worktreeStatus?.forget(project.id)
    return row.id
  }

  // --- create_worktree, list_worktrees ---------------------------------------------

  /** Creates worktrees identically to the interface then attaches requesting sessions through `conversation_paths`, never `conversations.worktree_id`. The latter controls resume cwd, and changing it would lose Claude transcripts organized by working directory. Keep cwd and use absolute paths for worktree edits. New branches start from project default branches, not HEAD: requesting sessions often inhabit main trees left on unexpected branches. */
  private async createWorktreeFor(requester: Requester, project: ProjectRow, payload: Record<string, unknown>): Promise<string> {
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
      `To start another session directly in this tree, use start_session with \`worktree: "${branch}"\`.`,
    ]
      .filter((line) => line !== null)
      .join('\n')
  }

  /** Project trees and progress as shown in Worktrees. Await fresh calculations rather than return interface-acceptable stale lists because agents make reuse decisions from answers. */
  private async listWorktrees(requester: Requester, project: ProjectRow): Promise<string> {
    if (!this.worktreeStatus) throw new Refusal('Worktree progress is unavailable here.')
    const list = await this.worktreeStatus.current(project)
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
  private async removeWorktreeFor(requester: Requester, project: ProjectRow, payload: Record<string, unknown>): Promise<string> {
    if (!this.worktreeStatus || !this.worktreeCleanup) throw new Refusal('Worktree cleanup is unavailable here.')
    const target = typeof payload.worktree === 'string' ? payload.worktree.trim() : ''
    if (!target) throw new Refusal('The `worktree` parameter is required: a name from list_worktrees, or the tree path.')
    const force = payload.force === true
    const deleteBranch = typeof payload.delete_branch === 'boolean' ? payload.delete_branch : null
    const archive = payload.archive_sessions !== false

    const list = await this.worktreeStatus.current(project)
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

  private launchCard(projectId: string, value: unknown): { id: string; number: number; title: string } | null {
    if (value === undefined || value === null || value === '') return null
    const number = typeof value === 'number' ? value : Number(String(value).replace(/^#/, ''))
    if (!Number.isInteger(number)) throw new Refusal('The `card` parameter is a card number, e.g. 12.')
    const card = this.ctx.db
      .select({ id: cards.id, number: cards.number, title: cards.title })
      .from(cards)
      .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
      .get()
    if (!card) throw new Refusal(`No card #${number} in this project. Use list_cards to see cards.`)
    return card
  }

  // --- schedule_task -------------------------------------------------------------

  /** Creates scheduled tasks like interface forms. Model/effort choices remain available but permissions retain project defaults, especially important for unattended runs. Responses repeat them so agents can inform users. */
  private async scheduleTask(
    requester: Requester,
    project: ProjectRow,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (requester.scheduleId) {
      throw new Refusal(
        'Refused: this session is itself a scheduled run. Tasks creating more tasks would multiply unattended; create a card with create_card instead.',
      )
    }

    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) throw new Refusal('The `name` parameter is required: a short task name.')
    if (name.length > MAX_SCHEDULE_NAME_CHARS) {
      throw new Refusal(`Name too long (maximum ${MAX_SCHEDULE_NAME_CHARS} characters).`)
    }
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) throw new Refusal('The `prompt` parameter is required: instructions replayed at each run.')
    if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS) {
      throw new Refusal(
        `Instructions too long (${prompt.length} characters, maximum ${MAX_SCHEDULE_PROMPT_CHARS}). Put details in a file and cite it.`,
      )
    }

    const [existing] = this.ctx.db
      .select({ total: count() })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.projectId, project.id))
      .all()
    if ((existing?.total ?? 0) >= MAX_AGENT_SCHEDULES_PER_PROJECT) {
      throw new Refusal(
        `Refused: this project already has ${MAX_AGENT_SCHEDULES_PER_PROJECT} scheduled tasks. The user can remove some in Scheduling.`,
      )
    }

    const cadence = parseAgentCadence(payload)
    const maxDurationMinutes = payload.max_duration_minutes ?? DEFAULT_SCHEDULE_DURATION_MINUTES
    if (
      typeof maxDurationMinutes !== 'number' ||
      !Number.isInteger(maxDurationMinutes) ||
      maxDurationMinutes < MIN_SCHEDULE_DURATION_MINUTES ||
      maxDurationMinutes > MAX_SCHEDULE_DURATION_MINUTES
    ) {
      throw new Refusal(
        `\`max_duration_minutes\` must be an integer between ${MIN_SCHEDULE_DURATION_MINUTES} and ${MAX_SCHEDULE_DURATION_MINUTES}.`,
      )
    }
    const overlap = payload.overlap ?? 'skip'
    if (overlap !== 'skip' && overlap !== 'wait') {
      throw new Refusal('`overlap` must be `skip` (skip this run) or `wait` (wait for the previous run to finish).')
    }
    const checkScript = checkScriptSchema.safeParse(payload.check_script ?? null)
    if (!checkScript.success) {
      throw new Refusal(`\`check_script\` is the script text, at most ${MAX_CHECK_SCRIPT_CHARS} characters.`)
    }
    const checkTimeout = checkTimeoutSchema.safeParse(payload.check_timeout_seconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS)
    if (!checkTimeout.success) {
      throw new Refusal(
        `\`check_timeout_seconds\` must be an integer between ${MIN_CHECK_TIMEOUT_SECONDS} and ${MAX_CHECK_TIMEOUT_SECONDS}.`,
      )
    }

    const agent = this.parseAgent(payload.agent, requester.agent)
    const config = await this.launchConfig(agent, project, requester.userId, payload, requester.apiToken)
    const task = createScheduledTask(
      this.ctx.db,
      { projectId: project.id, userId: requester.userId, conversationId: requester.id || undefined },
      {
        name,
        agent,
        config,
        prompt,
        cadence,
        overlapPolicy: overlap,
        maxDurationMinutes,
        enabled: true,
        checkScript: checkScript.data,
        checkTimeoutSeconds: checkTimeout.data,
      },
    )

    const lines = [
      `Scheduled task “${task.name}” created, id ${task.id}.`,
      `Cadence: ${describeCadence(cadence)}. Next run: ${task.nextRunAt ? new Date(task.nextRunAt).toISOString() : 'none'}.`,
      `Each run opens a new session: CLI ${agent}, model ${describeModel(config)}, effort ${describeEffort(config)}, maximum ${task.maxDurationMinutes} min, at the project root.`,
      describePermissions(config)
        ? 'Warning: with project default permissions, runs may stop for approval nobody will provide, until their maximum duration. Tell the user to adjust task permissions in Scheduling.'
        : null,
      task.checkScript
        ? 'The check script awaits user approval: until approved, runs are skipped without running the script or opening a session. Tell the user they can review, test and approve it below this tool call or in project Automations.'
        : null,
      'The user can edit, pause, run or delete it in project Scheduling. Runs appear under the task rather than in the session list.',
    ]
    return lines.filter(Boolean).join('\n')
  }

  // --- create_automation ---------------------------------------------------------

  /** Webhook automation with `schedule_task` limits: no creation by automation-born sessions and project caps. Return signing secrets because agents need them to configure caller webhooks (`gh api repos/…/hooks`). */
  private async createAutomation(
    requester: Requester,
    project: ProjectRow,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (!this.encryptionKey) throw new Refusal('Automations are unavailable on this server.')
    if (requester.scheduleId) {
      throw new Refusal(
        'Refused: this session was started by an automation or scheduled task. Automations creating more automations would multiply unattended; create a card with create_card instead.',
      )
    }
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) throw new Refusal('The `name` parameter is required.')
    if (name.length > MAX_SCHEDULE_NAME_CHARS) throw new Refusal(`Name too long (maximum ${MAX_SCHEDULE_NAME_CHARS} characters).`)

    const template = payload.template === undefined || payload.template === null || payload.template === ''
      ? null
      : AUTOMATION_TEMPLATES.find((entry) => entry.id === payload.template)
    if (template === undefined) {
      throw new Refusal(`Unknown template “${String(payload.template)}”. Available values: ${AUTOMATION_TEMPLATES.map((entry) => entry.id).join(', ')}.`)
    }
    const prompt = typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt.trim() : (template?.prompt.en ?? '')
    if (!prompt) throw new Refusal('Without a template, `prompt` is required: instructions with `{{payload.…}}` placeholders.')
    if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS) throw new Refusal(`Instructions too long (maximum ${MAX_SCHEDULE_PROMPT_CHARS} characters).`)

    const settings: Partial<WebhookSettings> = { ...template?.settings }
    if (payload.conditions !== undefined) {
      const parsed = automationConditionsSchema.safeParse({ mode: payload.match ?? 'all', rules: payload.conditions })
      if (!parsed.success) throw new Refusal(describeZod(parsed.error))
      settings.conditions = parsed.data
    }
    if (typeof payload.subject_path === 'string') settings.subjectPath = payload.subject_path.trim()
    if (payload.verification !== undefined) {
      const presets: Record<string, WebhookVerification> = {
        github: { kind: 'hmac', header: 'x-hub-signature-256', algorithm: 'sha256', prefix: 'sha256=' },
        gitlab: { kind: 'token', header: 'x-gitlab-token' },
        none: { kind: 'none' },
      }
      const chosen = presets[String(payload.verification)]
      if (!chosen) throw new Refusal('`verification` must be `github`, `gitlab` or `none`.')
      settings.verification = chosen
    }

    const [existing] = this.ctx.db
      .select({ total: count() })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.projectId, project.id))
      .all()
    if ((existing?.total ?? 0) >= MAX_AGENT_SCHEDULES_PER_PROJECT) {
      throw new Refusal(`Refused: this project already has ${MAX_AGENT_SCHEDULES_PER_PROJECT} automations and scheduled tasks.`)
    }

    const agent = this.parseAgent(payload.agent, requester.agent)
    const config = await this.launchConfig(agent, project, requester.userId, payload, requester.apiToken)
    const key = this.encryptionKey
    const { task, hook } = this.ctx.db.transaction(() => {
      const task = createScheduledTask(
        this.ctx.db,
        { projectId: project.id, userId: requester.userId, conversationId: requester.id || undefined },
        {
          name,
          agent,
          config,
          prompt,
          cadence: { kind: 'webhook' },
          overlapPolicy: 'wait',
          maxDurationMinutes: DEFAULT_SCHEDULE_DURATION_MINUTES,
          enabled: true,
        },
      )
      return { task, hook: createWebhook(this.ctx.db, key, task.id, settings, template?.id ?? null) }
    })
    const url = webhookUrl(this.ctx.config.server.publicUrl, hook.token)
    const verification = readSettings(hook).verification
    const secret = revealSecret(key, hook)

    return [
      `Automation “${task.name}” created (id ${task.id}), enabled.`,
      `Adresse : ${url}`,
      verification.kind === 'none'
        ? 'Verification: none; the URL alone is sufficient. Tell the user.'
        : `Signing secret: ${secret} (${verification.kind === 'hmac' ? `HMAC ${verification.algorithm} in header ${verification.header}` : `token in header ${verification.header}`}). Copy it only into the webhook configuration.`,
      'For GitHub: `gh api repos/OWNER/REPO/hooks -f name=web -F active=true -f "events[]=issues" -f config[url]=<url> -f config[content_type]=json -f config[secret]=<secret>` (adapt events to conditions).',
      `Each accepted call opens a new session (CLI ${agent}, model ${describeModel(config)}), one at a time, maximum ${DEFAULT_SCHEDULE_DURATION_MINUTES} min; exceeding ${readSettings(hook).maxRunsPerHour} launches per hour pauses it.`,
      'The user adjusts conditions, script and prompt in project Automations, which also shows received calls and their outcomes.',
    ].join('\n')
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

  private updateCard(requester: Requester, payload: Record<string, unknown>): string {
    if (!Number.isInteger(payload.number)) throw new Refusal('The card number is required.')
    const card = this.ctx.db.select().from(cards)
      .where(and(eq(cards.projectId, requester.projectId), eq(cards.number, payload.number as number))).get()
    if (!card) throw new Refusal('No card with this number in the project.')
    const body = updateCardBodySchema.pick({ title: true, description: true }).parse({
      title: typeof payload.title === 'string' ? payload.title.trim() : payload.title,
      description: payload.description,
    })
    if (body.title === undefined && body.description === undefined && payload.tags === undefined) {
      throw new Refusal('Provide at least a title, description or tags to change.')
    }
    // Resolve tags before writing anything: a refused name must leave the card untouched.
    const tags = payload.tags === undefined ? null : this.resolveTags(requester, payload.tags)
    if (tags) setCardTags(this.ctx.db, card.id, requester.projectId, tags.ids)
    updateCard(this.ctx.db, card, body)
    this.board?.kick(requester.projectId)
    return `Card #${card.number} updated.${tags ? describeTags(tags) : ''}`
  }

  private resolveTags(requester: Requester, names: unknown): { ids: string[]; created: string[]; names: string[] } {
    const author: TagAuthor = { userId: requester.userId, conversationId: requester.id || null }
    try {
      const resolved = resolveAgentTags(this.ctx.db, requester.projectId, names, author)
      return { ...resolved, names: (names as string[]).map((name) => name.trim()).filter(Boolean) }
    } catch (err) {
      if (err instanceof TagRefusal) throw new Refusal(err.message)
      throw err
    }
  }

  // --- attach_card / detach_card -------------------------------------------------

  /**
   * Attaches the requesting session to a card, the link the board counts as work on it. Unlike
   * attaching from the interface, which records past work, an agent attaches as it starts: a
   * card still in todo therefore moves to in progress, as when a session is launched from it.
   */
  private attachCard(kind: 'attach_card' | 'detach_card', requester: Requester, payload: Record<string, unknown>): string {
    if (!requester.id || requester.personal) throw new Refusal('Only a project session can be attached to one of its cards.')
    const current = this.ctx.db.select({ cardId: conversations.cardId }).from(conversations).where(eq(conversations.id, requester.id)).get()
    if (kind === 'detach_card') {
      if (!current?.cardId) return 'This session is not attached to a card.'
      const card = this.ctx.db.select({ number: cards.number }).from(cards).where(eq(cards.id, current.cardId)).get()
      this.ctx.db.update(conversations).set({ cardId: null }).where(eq(conversations.id, requester.id)).run()
      this.sessions.statusBus.emit('lists')
      return card ? `Session detached from card #${card.number}; the card keeps its column and notes.` : 'Session detached.'
    }

    const card = this.launchCard(requester.projectId, payload.number)
    if (!card) throw new Refusal('The `number` parameter is required: the card number, e.g. 12.')
    if (current?.cardId === card.id) return `This session is already attached to card #${card.number} “${card.title}”.`
    const previous = current?.cardId
      ? this.ctx.db.select({ number: cards.number }).from(cards).where(eq(cards.id, current.cardId)).get()
      : undefined
    this.ctx.db.update(conversations).set({ cardId: card.id }).where(eq(conversations.id, requester.id)).run()
    const advanced = this.ctx.db
      .update(cards)
      .set({ column: 'in_progress', updatedAt: Date.now() })
      .where(and(eq(cards.id, card.id), eq(cards.column, 'todo')))
      .run().changes > 0
    this.board?.kick(requester.projectId)
    this.sessions.statusBus.emit('lists')
    return [
      `Session attached to card #${card.number} “${card.title}”${previous ? ` (replacing #${previous.number})` : ''}${advanced ? ', moved to in progress' : ''}.`,
      'The user now sees the card in the session list and header. Call read_card for its description and previous notes if you have not; leave a note with add_card_note before finishing.',
    ].join(' ')
  }

  // --- create_card ---------------------------------------------------------------

  /** Always create todo cards: agent ideas are proposals rather than started work. Advance when sessions take them, like other cards. */
  private async createCard(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    const description = typeof payload.description === 'string' ? payload.description.trim() : ''
    if (!title) throw new Refusal('The `title` parameter is required.')
    if (title.length > 200) throw new Refusal('Title too long (maximum 200 characters).')
    if (description.length > 20000) throw new Refusal('Description too long (maximum 20,000 characters).')
    const tags = payload.tags === undefined ? null : this.resolveTags(requester, payload.tags)

    // Board settings decide unless agents explicitly request otherwise based on
    // user instructions, as tool descriptions require.
    const link = this.board?.link(requester.projectId)
    if (payload.github === true && !link) {
      throw new Refusal('This board is not linked to GitHub: cards can only be local. Retry without `github`.')
    }
    const github = Boolean(link) && (typeof payload.github === 'boolean' ? payload.github : link?.newCards === 'github')
    const fields = { title, description, column: 'todo' as const }
    const card =
      github && this.board
        ? await this.board.createIssueCard(
            requester.projectId,
            requester.userId,
            fields,
            requester.id ? { agent: requester.agent, conversationId: requester.id } : undefined,
          )
        : createCard(this.ctx.db, requester.projectId, requester.userId, fields)
    if (tags && tags.ids.length > 0) setCardTags(this.ctx.db, card.id, requester.projectId, tags.ids)
    // Provenance lives in card threads with session links, preserving agent-written
    // descriptions while showing origins to subsequent users.
    // Account-created cards already identify their authors.
    if (requester.id) {
      this.ctx.db
        .insert(cardNotes)
        .values({
          id: randomUUID(),
          cardId: card.id,
          conversationId: requester.id,
          userId: null,
          body: 'Carte ouverte depuis cette session.',
          createdAt: Date.now(),
        })
        .run()
    }

    const issue = github ? this.board?.issueOf(card.id) : undefined
    const where = issue
      ? ` and published as GitHub issue #${issue.number} (${issue.url}), visible to everyone if the repository is public`
      : link
        ? ', local (not published to GitHub)'
        : ''
    return `Card #${card.number} “${card.title}” created in todo${where}.${tags ? describeTags(tags) : ''} To handle it immediately, use start_session with card=${card.number}.`
  }

  // --- actions -------------------------------------------------------------------

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
  private registerAction(requester: Requester, payload: Record<string, unknown>): string {
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

  private async removeAction(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    const row = this.projectAction(requester, payload.id)
    await this.actions?.forget(row)
    deleteAction(this.ctx.db, row.id)
    return `Action “${row.label}” deleted${row.kind === 'service' ? ', and its service stopped' : ''}.`
  }

  /** Runs actions in requester worktrees, even proposed actions: agents could run identical shell commands already. Review protects user clicks rather than agents from themselves. */
  private async runAction(requester: Requester, payload: Record<string, unknown>): Promise<string> {
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

  // --- Existing-session operations -----------------------------------------------

  /** Personal assistants and sessionless clients manage the account's project sessions.
   * Project sessions keep signed inter-session delivery. Target ownership still applies. */
  private async actOnSession(
    kind: 'message_session' | 'steer_session' | 'interrupt_session' | 'reply_session',
    requester: Requester,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (requester.id && !requester.personal) {
      throw new Refusal('This tool is only for clients outside sessions: from a session, use send_session_message.')
    }
    const id = typeof payload.session === 'string' ? payload.session.trim() : ''
    if (!id) throw new Refusal('The `session` parameter is required: its ID from list_sessions.')
    const target = this.ctx.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.projectId, requester.projectId), isNull(conversations.archivedAt)))
      .get()
    if (!target || target.userId !== requester.userId) {
      throw new Refusal(`No session “${id}” belonging to you in this project. Use list_sessions to see sessions.`)
    }

    if (kind === 'interrupt_session') {
      if (target.status !== 'running' && target.status !== 'awaiting_input') return `Session “${target.title}” is not working (${target.status}): nothing to interrupt.`
      await this.sessions.interrupt(target.id)
      return `Turn of “${target.title}” interrupted. A message resumes it with its context.`
    }

    if (requester.apiToken) assertTokenExecution(requester.apiToken, agentConfigSchema.parse(JSON.parse(target.config)))

    if (kind === 'reply_session') return this.replyToSession(target, requester, payload)

    const body = typeof payload.body === 'string' ? payload.body.trim() : ''
    if (!body) throw new Refusal('The `body` parameter is required.')
    if (body.length > MAX_LAUNCH_PROMPT_CHARS) {
      throw new Refusal(`Message too long (${body.length} characters, maximum ${MAX_LAUNCH_PROMPT_CHARS}).`)
    }
    if (kind === 'steer_session') {
      // Steering exists only during active turns and callers often lose the
      // race: fall back to an ordinary message rather than losing the text.
      const steered = await this.sessions.steer(target.id, randomUUID(), body, [], [])
      if (steered) return `Turn of “${target.title}” steered: the CLI reads the message during its current turn.`
      await this.sessions.sendMessage(target.id, randomUUID(), body, [], [])
      return `No turn to steer in “${target.title}” (or its CLI does not support steering): sent as an ordinary message starting a turn.`
    }
    const busy = target.status === 'running'
    await this.sessions.sendMessage(target.id, randomUUID(), body, [], [])
    return busy
      ? `Message queued for “${target.title}”: it is working and will receive it after its turn. Use wait_for_session then read_session for its reply.`
      : `Message delivered to “${target.title}”: resuming as if the user typed it in Sillage. Use wait_for_session then read_session for its reply.`
  }

  /** Answers open requests according to type, like API `replies` routes. */
  private async replyToSession(target: ConversationRow, requester: Requester, payload: Record<string, unknown>): Promise<string> {
    if (!this.log) throw new Refusal('Replies to requests are unavailable on this server.')
    const requestId = typeof payload.request_id === 'string' ? payload.request_id.trim() : ''
    const open = this.log.openPrompts(target.id)
    const pending = requestId ? open.find((prompt) => prompt.requestId === requestId) : open[0]
    if (!pending) {
      throw new Refusal(
        requestId
          ? `No pending request “${requestId}” in this session: read_session shows what it awaits.`
          : `Session “${target.title}” is not awaiting a reply.`,
      )
    }
    const parsed = taskReplyBodySchema.safeParse({ kind: pending.kind, ...payload })
    if (!parsed.success) throw new Refusal(`Malformed reply for request type ${pending.kind}: ${describeZod(parsed.error)}`)
    const body = parsed.data
    const decidedBy = requester.userId
    let resolved: boolean
    switch (body.kind) {
      case 'permission':
        resolved = this.sessions.resolvePermission(target.id, pending.requestId, { decision: body.decision, scope: body.scope, decidedBy })
        break
      case 'question':
        resolved = await this.sessions.answerQuestion(target.id, pending.requestId, { status: body.status, answers: body.answers, decidedBy })
        break
      case 'plan':
        resolved = this.sessions.reviewPlan(target.id, pending.requestId, { decision: body.decision, followUpMode: body.followUpMode, decidedBy })
        break
      case 'elicitation':
        resolved = this.sessions.resolveElicitation(target.id, pending.requestId, { action: body.action, content: body.content, decidedBy })
        break
    }
    if (!resolved) throw new Refusal('This request expired: the session stopped in the meantime. A message resumes it.')
    return `Reply (${body.kind}) delivered to “${target.title}”: continuing. Use wait_for_session then read_session for progress.`
  }

  // --- list_models ---------------------------------------------------------------

  private async listModels(
    requester: Pick<Requester, 'userId' | 'agent' | 'apiToken'>,
    project: ProjectRow | null,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const agents: AgentKind[] =
      payload.agent === undefined || payload.agent === null || payload.agent === ''
        ? [...agentKindSchema.options]
        : [this.parseAgent(payload.agent, requester.agent)]

    const policy = requester.apiToken ? readExecutionPolicy(requester.apiToken) : null
    if (payload.agent) for (const agent of agents) assertAgentAllowed(policy, agent)
    const sections: string[] = []
    for (const agent of agents.filter((kind) => !policy || policy.agents.some((rule) => rule.agent === kind))) {
      const defaults = await this.launchConfig(agent, project, requester.userId, {}, requester.apiToken).catch(() => null)
      const models = await (defaults ? this.sessions.modelsFor(requester.userId, defaults) : this.registry.adapter(agent).models())
        .then((listing) => allowedModels(policy, agent, listing.models))
        .catch(() => null)
      const head = defaults
        ? `## ${agent} — defaults: model ${describeModel(defaults)}, effort ${describeEffort(defaults)}`
        : `## ${agent}`
      if (!models) {
        sections.push(`${head}\nCatalog unavailable: the CLI may not be installed.`)
        continue
      }
      const lines = models.map((model) => {
        const efforts = model.efforts.map((entry) => entry.value)
        return `- \`${model.value}\` (${model.displayName})${model.isDefault ? ' [CLI default]' : ''}${efforts.length > 0 ? ` — efforts: ${efforts.join(', ')}` : ''}`
      })
      sections.push([head, ...lines].join('\n'))
    }
    return `${sections.join('\n\n')}\n\nIn start_session, \`model\` accepts a value or display name, and \`effort: "max"\` selects the highest level when the model has no level with that name.`
  }
}

/** Agent cadence: exactly one of `every_minutes`, `cron`, `at`. Flat parameters rather than discriminated objects match familiar `CronCreate` and reduce model mistakes. */
function parseAgentCadence(payload: Record<string, unknown>): ScheduleCadence {
  const given = ['every_minutes', 'cron', 'at'].filter(
    (key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== '',
  )
  if (given.length !== 1) {
    throw new Refusal(
      'Provide exactly one cadence: `every_minutes` (interval), `cron` (five-field pattern), or `at` (single ISO 8601 date and time).',
    )
  }

  let candidate: unknown
  if (given[0] === 'every_minutes') {
    candidate = { kind: 'interval', minutes: payload.every_minutes }
  } else if (given[0] === 'cron') {
    candidate = { kind: 'cron', expression: typeof payload.cron === 'string' ? payload.cron.trim() : payload.cron }
  } else {
    const at = typeof payload.at === 'string' ? Date.parse(payload.at) : Number.NaN
    if (Number.isNaN(at)) throw new Refusal('`at` must be an ISO 8601 date, e.g. 2026-10-12T09:00:00+02:00.')
    if (at <= Date.now()) throw new Refusal('`at` is in the past.')
    candidate = { kind: 'once', at }
  }

  const parsed = scheduleCadenceSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Refusal(
      given[0] === 'cron'
        ? `Invalid cron pattern “${String(payload.cron)}”: use five fields (minute hour day month weekday), in server time.`
        : '`every_minutes` must be a positive integer.',
    )
  }

  const cadence = parsed.data
  if (cadence.kind === 'interval' && cadence.minutes < MIN_AGENT_SCHEDULE_MINUTES) {
    throw new Refusal(`Interval too short: minimum ${MIN_AGENT_SCHEDULE_MINUTES} minutes.`)
  }
  if (cadence.kind === 'cron') {
    const [first, second] = new Cron(cadence.expression, { paused: true }).nextRuns(2)
    if (first && second && second.getTime() - first.getTime() < MIN_AGENT_SCHEDULE_MINUTES * 60_000) {
      throw new Refusal(`Pattern too frequent: minimum ${MIN_AGENT_SCHEDULE_MINUTES} minutes between runs.`)
    }
  }
  return cadence
}

function describeCadence(cadence: ScheduleCadence): string {
  if (cadence.kind === 'interval') return `every ${cadence.minutes} minutes`
  if (cadence.kind === 'cron') return `cron pattern \`${cadence.expression}\``
  if (cadence.kind === 'webhook') return 'on each webhook call'
  return `once, at ${new Date(cadence.at).toISOString()}`
}

function nameModel(model: AgentModelDto): string {
  return model.displayName && model.displayName !== model.value ? `${model.value} (${model.displayName})` : model.value
}

/** Finds models by agent-supplied names, often user labels such as 'Astra' or 'opus' instead of exact IDs. */
export function matchModel(catalog: AgentModelDto[], wanted: string): AgentModelDto | null {
  const needle = wanted.toLowerCase()
  const exact = catalog.find((model) => model.value.toLowerCase() === needle)
  if (exact) return exact
  const named = catalog.find((model) => model.displayName.toLowerCase() === needle)
  if (named) return named
  const partial = catalog.filter(
    (model) => model.value.toLowerCase().includes(needle) || model.displayName.toLowerCase().includes(needle),
  )
  // Require unique candidates: guessing between models would choose on behalf
  // of the user.
  return partial.length === 1 ? (partial[0] ?? null) : null
}

/** `max` selects a literal level when available (Codex has one below `ultra`), otherwise the model maximum. Users request maximum effort without knowing models may stop at `xhigh`. Catalog levels run lowest to highest. */
export function matchEffort(efforts: string[], wanted: string): string | null {
  if (efforts.includes(wanted)) return wanted
  if (wanted === 'max' || wanted === 'maximum') return efforts.at(-1) ?? null
  if (wanted === 'min' || wanted === 'minimum') return efforts[0] ?? null
  return null
}

function withEffort(config: AgentConfig, effort: string): AgentConfig {
  // Schemas reject unsupported Claude levels later; the cast merely passes
  // the string through to validation.
  if (config.agent === 'claude') return { ...config, effort: effort as typeof config.effort }
  if (config.agent === 'codex' || config.agent === 'grok' || config.agent === 'antigravity') return { ...config, reasoningEffort: effort }
  return { ...config, variant: effort }
}

/** Effort named according to each CLI, including opencode variants. */
function effortOf(config: AgentConfig): string {
  if (config.agent === 'claude') return config.effort
  if (config.agent === 'opencode') return config.variant
  return config.reasoningEffort
}

function describeModel(config: AgentConfig): string {
  return config.model || 'CLI default'
}

function describeEffort(config: AgentConfig): string {
  return effortOf(config) || 'CLI default'
}

function describePermissions(config: AgentConfig): string | null {
  if (config.agent === 'claude' && config.permissionMode === 'manual') {
    return 'Permissions are manual, following project defaults: it will pause to ask the user before acting.'
  }
  if (config.agent === 'codex' && config.askForApproval !== 'never' && config.askForApproval !== '') {
    return 'It will ask for user approval outside its sandbox, following project defaults.'
  }
  if (config.agent === 'opencode' && (config.permissions.edit === 'ask' || config.permissions.bash === 'ask')) {
    return 'It will ask for user permission before writing or executing, following project defaults.'
  }
  if (config.agent === 'grok' && (config.permissionMode === 'default' || config.permissionMode === 'plan')) {
    return 'It will ask for user permission before writing or executing, following project defaults.'
  }
  return null
}

function describeZod(error: ZodError): string {
  const issues = error.issues.map((issue) => `\`${issue.path.join('.') || 'parameters'}\`: ${issue.message}`)
  return `Invalid parameters — ${issues.join('; ')}`
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
      return `“${label}” failed to start (${state}). Logs: journalctl --user -u ${service.unit} -n 50`
    }
    return `“${label}” started (${state}). Logs: journalctl --user -u ${service.unit} -n 50`
  }
  const terminal = result.terminal
  if (result.alreadyRunning) return `“${label}” is already running in panel terminal “${terminal?.title ?? label}”.`
  return `“${label}” started in a panel terminal visible to the user. You cannot read its output: run the command in your shell if you need the result yourself.`
}

/** Why `from` cannot launch more sessions, or null: excessive chain depth or hourly launches. Shared with webhooks: session-marked calls count as its `webhook_launch`, applying identical limits whether chains use start_session or GitHub issues. */
export function launchRefusal(
  db: AppContext['db'],
  from: string,
  excludeRequestId?: string,
): { reason: DeliveryReason; message: string } | null {
  let depth = 0
  let current = from
  while (depth <= MAX_LAUNCH_DEPTH) {
    const parent = db
      .select({ from: agentRequests.conversationId })
      .from(agentRequests)
      .where(eq(agentRequests.launchedConversationId, current))
      .get()
    if (!parent) break
    depth += 1
    current = parent.from
  }
  if (depth >= MAX_LAUNCH_DEPTH) {
    return {
      reason: { code: 'chain_depth', params: { depth, max: MAX_LAUNCH_DEPTH } },
      // Agent messages use English like all Sillage model-facing text;
      // coded reasons go to interfaces for translation.
      message: `Refused: this session was itself launched by another agent-launched session (${depth} levels). Launch chains cannot exceed ${MAX_LAUNCH_DEPTH}. Create a card with create_card, or suggest that the user start the session themselves.`,
    }
  }

  const [recent] = db
    .select({ total: count() })
    .from(agentRequests)
    .where(
      and(
        eq(agentRequests.conversationId, from),
        inArray(agentRequests.kind, ['start_session', 'webhook_launch']),
        eq(agentRequests.isError, false),
        ...(excludeRequestId ? [ne(agentRequests.id, excludeRequestId)] : []),
        gt(agentRequests.createdAt, Date.now() - HOUR_MS),
      ),
    )
    .all()
  if ((recent?.total ?? 0) >= LAUNCHES_PER_HOUR) {
    return {
      reason: { code: 'chain_rate', params: { max: LAUNCHES_PER_HOUR } },
      message: `Refused: this session has already launched ${LAUNCHES_PER_HOUR} sessions in the last hour. Create cards with create_card for the rest; the user can start them.`,
    }
  }
  return null
}

/** Tag outcome for the agent, naming new tags so it can tell the user it grew the catalog. */
function describeTags(tags: { created: string[]; names: string[] }): string {
  if (tags.names.length === 0) return ' Tags cleared.'
  const created = tags.created.length > 0 ? ` New tag(s) created: ${tags.created.join(', ')}.` : ''
  return ` Tags: ${tags.names.join(', ')}.${created}`
}
