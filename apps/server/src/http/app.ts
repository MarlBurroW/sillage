import { registerNewsRoutes } from './routes/news.js'
import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import type { SessionRelay } from '../sessions/session-relay.js'
import type { AgentRegistry } from '../agents/registry.js'
import { CliInstaller } from '../agents/cli-install.js'
import type { AttachmentStore } from '../attachments/store.js'
import { bearerSecret, resolveApiToken } from '../auth/api-tokens.js'
import { SESSION_COOKIE, resolveSession } from '../auth/sessions.js'
import type { EventLog } from '../events/event-log.js'
import type { PushService } from '../push/push-service.js'
import type { SessionManager } from '../sessions/session-manager.js'
import type { TerminalManager } from '../terminals/terminal-manager.js'
import { registerTerminalHub } from '../ws/terminal-hub.js'
import { registerWebSocketHub } from '../ws/hub.js'
import { MAX_ATTACHMENT_BYTES } from '@sillage/protocol'
import type { AppContext } from './context.js'
import { HttpError, registerErrorHandler, unauthorized } from './errors.js'
import { registerLocalOriginGuard } from './local-origin.js'
import { INSTANCE_PROFILE } from '../instance/profile.js'
import { registerApiTokenRoutes } from './routes/api-tokens.js'
import { registerV1Routes } from './v1/index.js'
import type { Scheduler } from '../scheduler/scheduler.js'
import type { TaskScheduler } from '../scheduler/task-scheduler.js'
import { registerScheduleRoutes } from './routes/schedules.js'
import { registerActionRoutes } from './routes/actions.js'
import { HOOKS_PREFIX, registerAutomationRoutes } from './routes/automations.js'
import type { AutomationReceiver } from '../automations/receiver.js'
import type { ActionRunner } from '../actions/actions.js'
import type { WebhookService } from '../webhooks/service.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { registerInstructionRoutes } from './routes/instructions.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerSkillLibraryRoutes } from './routes/skill-library.js'
import { registerSkillSourceRoutes } from './routes/skill-sources.js'
import { SkillSources } from '../skill-library/sources.js'
import { SkillLibrary } from '../skill-library/store.js'
import { registerSecretRoutes } from './routes/secrets.js'
import type { SecretStore } from '../secrets/store.js'
import { registerGitCredentialRoutes } from './routes/git-credentials.js'
import { registerClaudeAccountRoutes } from './routes/claude-accounts.js'
import { registerCodexAccountRoutes } from './routes/codex-accounts.js'
import { registerGrokAccountRoutes } from './routes/grok-accounts.js'
import { CloneJobs } from '../clone-jobs.js'
import { GitHubRepoCatalog } from '../git-credentials/github.js'
import type { GitCredentialStore } from '../git-credentials/store.js'
import type { ClaudeAccountStore } from '../claude-accounts/store.js'
import type { ClaudeLoginService } from '../claude-accounts/login.js'
import type { CodexAccountHomes } from '../codex-accounts/homes.js'
import type { CodexLoginService } from '../codex-accounts/login.js'
import type { CodexAccountStore } from '../codex-accounts/store.js'
import type { GrokAccountHomes } from '../grok-accounts/homes.js'
import type { GrokLoginService } from '../grok-accounts/login.js'
import type { GrokAccountStore } from '../grok-accounts/store.js'
import { registerAttachmentRoutes } from './routes/attachments.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerClaudeSessionRoutes } from './routes/claude-sessions.js'
import { registerCardRoutes } from './routes/cards.js'
import { registerBoardLinkRoutes } from './routes/board-link.js'
import type { BoardSync } from '../board/board-sync.js'
import { registerConversationRoutes } from './routes/conversations.js'
import { registerSessionMessageRoutes } from './routes/session-messages.js'
import { registerFileRoutes } from './routes/files.js'
import { registerGitActionRoutes } from './routes/git-actions.js'
import { registerGitViewRoutes } from './routes/git-views.js'
import { registerCheckpointRoutes } from './routes/checkpoints.js'
import { registerFsRoutes } from './routes/fs.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerPaletteRoutes } from './routes/palette.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerPushRoutes } from './routes/push.js'
import { registerDecisionRoutes } from './routes/decisions.js'
import type { DecisionService } from '../decisions/service.js'
import type { Notifications } from '../notifications/dispatcher.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerSttRoutes } from './routes/stt.js'
import { registerSystemRoutes } from './routes/system.js'
import { registerServiceRoutes } from './routes/services.js'
import { registerTerminalRoutes } from './routes/terminals.js'
import { registerTreeRoutes } from './routes/tree.js'
import { registerUserSettingsRoutes } from './routes/user-settings.js'
import { registerUserRoutes } from './routes/users.js'
import { registerWorktreeRoutes } from './routes/worktrees.js'
import type { WorktreeCleanup } from '../worktrees/cleanup.js'
import type { WorktreeStatusService } from '../worktrees/status-service.js'

/**
 * Routes accessible without a session. Everything else requires a user.
 *
 * This includes the instance profile: the interface needs it before rendering
 * anything, including the login page.
 */
const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/auth/setup', '/api/health', '/api/system/instance'])

/**
 * Public API reserved for tokens.
 *
 * The boundary works both ways: cookies cannot enter and tokens cannot leave
 * this prefix. Interface DTOs can evolve without becoming a public contract,
 * and stolen tokens cannot reach account administration.
 */
const API_V1_PREFIX = '/api/v1/'

export async function buildApp(
  ctx: AppContext,
  log: EventLog,
  sessions: SessionManager,
  registry: AgentRegistry,
  attachments: AttachmentStore,
  terminals: TerminalManager,
  push: PushService,
  secrets: SecretStore,
  gitCredentials: GitCredentialStore,
  claudeAccounts: ClaudeAccountStore,
  claudeLogin: ClaudeLoginService,
  codexAccounts: { store: CodexAccountStore; homes: CodexAccountHomes },
  codexLogin: CodexLoginService,
  grokAccounts: { store: GrokAccountStore; homes: GrokAccountHomes },
  grokLogin: GrokLoginService,
  webhooks: WebhookService,
  scheduler: Scheduler,
  relay: SessionRelay,
  tasks: TaskScheduler,
  actions: ActionRunner,
  automations: AutomationReceiver,
  board: BoardSync,
  notifications: Notifications,
  decisions: DecisionService,
  worktreeStatus: WorktreeStatusService,
  worktreeCleanup: WorktreeCleanup,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.SILLAGE_LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  })

  registerErrorHandler(app)
  if (INSTANCE_PROFILE === 'desktop') registerLocalOriginGuard(app)

  /**
   * Nothing compressed responses along the path: neither Sillage nor its nginx
   * proxy, whose default `gzip_types` only includes `text/html`. Long conversations
   * reread uncompressed journals, up to 32 MB, especially noticeable remotely
   * where home upload bandwidth is the bottleneck.
   *
   * Keep the level low: level 1 reduces 32 MB to 14 MB; level 6 saves only another
   * 0.6 MB while doubling CPU time in the daemon already hosting the CLIs.
   */
  await app.register(compress, { global: true, zlibOptions: { level: 1 }, threshold: 1024 })
  await app.register(cookie)
  await app.register(multipart, {
    limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES },
  })

  // Resolve identity on every request. Routes then decide whether they
  // require a user through requireUser().
  app.addHook('onRequest', async (request) => {
    const secret = bearerSecret(request.headers.authorization)
    const identity = secret ? resolveApiToken(ctx.db, secret) : null
    if (identity) {
      request.apiToken = identity.token
      request.user = identity.user
      return
    }

    // Fall back to cookies even with an `Authorization` header: a proxy or
    // extension adding one must not make the interface unusable.
    const token = request.cookies[SESSION_COOKIE]
    if (!token) return
    const user = await resolveSession(ctx.db, token)
    if (user) request.user = user
  })

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return
    const path = request.url.split('?')[0] ?? request.url
    if (PUBLIC_ROUTES.has(path) || path === '/api/auth/logout') return
    // Webhooks have neither sessions nor tokens: their signature authenticates them.
    if (path.startsWith(HOOKS_PREFIX)) return

    if (path.startsWith(API_V1_PREFIX)) {
      if (!request.apiToken) {
        throw new HttpError(401, 'api_token_required', 'This API requires a bearer token.')
      }
      return
    }

    if (request.apiToken) {
      throw new HttpError(
        403,
        'token_outside_api',
        'A bearer token only grants access to /api/v1.',
      )
    }
    if (!request.user) throw unauthorized()
  })

  registerHealthRoutes(app)
  registerAuthRoutes(app, ctx)
  registerProjectRoutes(app, ctx, attachments, new CloneJobs(), terminals)
  registerConversationRoutes(app, ctx, log, sessions, registry, attachments, webhooks)
  registerCheckpointRoutes(app, ctx, sessions)
  registerSessionMessageRoutes(app, ctx, relay)
  registerClaudeSessionRoutes(app, ctx, log, sessions, registry)
  registerFsRoutes(app)
  registerAgentRoutes(
    app,
    ctx,
    registry,
    new CliInstaller(ctx.config.paths.agents, (kind) => registry.find(kind)?.cli.invalidate()),
    claudeAccounts,
    codexAccounts,
    grokAccounts,
  )
  registerMcpRoutes(app, ctx)
  // Sources read the library to install skills; the library reads source catalogs
  // to detect updates, so initialize sources first.
  const skillSources = new SkillSources(ctx.db, ctx.config.paths.skillSourcesCache)
  const skillLibrary = new SkillLibrary(
    ctx.db,
    ctx.config.paths.skillLibrary,
    (projectId) => sessions.reloadSkillLibrary(projectId),
    skillSources,
  )
  registerSkillLibraryRoutes(app, ctx, skillLibrary)
  registerInstructionRoutes(app, ctx)
  registerMemoryRoutes(app, ctx)
  registerSkillSourceRoutes(app, ctx, skillLibrary, skillSources)
  registerSecretRoutes(app, ctx, secrets)
  registerGitCredentialRoutes(app, gitCredentials, new GitHubRepoCatalog())
  registerClaudeAccountRoutes(app, claudeAccounts, claudeLogin)
  registerCodexAccountRoutes(app, codexAccounts.store, codexLogin)
  registerGrokAccountRoutes(app, grokAccounts.store, grokLogin)
  registerWorktreeRoutes(app, ctx, terminals, worktreeStatus, worktreeCleanup)
  registerCardRoutes(app, ctx, attachments, board)
  registerBoardLinkRoutes(app, ctx, board)
  registerUserRoutes(app, ctx)
  registerApiTokenRoutes(app, ctx, registry)
  registerV1Routes(app, ctx, log, sessions, registry, webhooks)
  registerAttachmentRoutes(app, attachments, ctx)
  registerPushRoutes(app, push)
  registerDecisionRoutes(app, decisions)
  registerSearchRoutes(app, ctx)
  registerPaletteRoutes(app, ctx, skillLibrary)
  registerSettingsRoutes(app, ctx, scheduler)
  registerScheduleRoutes(app, ctx, sessions, registry, tasks, automations)
  registerAutomationRoutes(app, ctx, automations)
  registerActionRoutes(app, ctx, sessions, actions)
  registerSttRoutes(app, ctx, secrets)
  registerUserSettingsRoutes(app, ctx)
  registerNewsRoutes(app, ctx)
  registerSystemRoutes(app, ctx)
  registerServiceRoutes(app, ctx)
  registerTreeRoutes(app, ctx)
  registerFileRoutes(app, ctx)
  registerGitViewRoutes(app, ctx)
  registerGitActionRoutes(app, ctx, worktreeStatus)
  registerTerminalRoutes(app, ctx, sessions, terminals)
  await registerWebSocketHub(app, ctx, log, sessions, notifications)
  // After the hub, which registers the websocket plugin required by terminals.
  registerTerminalHub(app, ctx, terminals)

  await registerWebClient(app, ctx)

  return app
}

/**
 * The built frontend is served statically by this process, without a frontend
 * Node server. During development, Vite serves the UI and proxies /api, so dist/
 * is absent and we simply return JSON.
 */
async function registerWebClient(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const indexPath = join(ctx.config.paths.webRoot, 'index.html')
  const hasBuild = existsSync(indexPath)

  if (hasBuild) {
    await app.register(fastifyStatic, {
      root: ctx.config.paths.webRoot,
      index: false,
      // The plugin's built-in cache-control would overwrite the value from setHeaders.
      cacheControl: false,
      /**
       * Only `assets/` files have hashed names and can be cached permanently.
       * Everything else (index.html, sw.js, manifest, icons) keeps a stable name;
       * immutable caching would prevent updates, including service worker updates.
       */
      setHeaders: (res, path) => {
        const hashed = path.includes(`${sep}assets${sep}`)
        res.setHeader(
          'cache-control',
          hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        )
      },
    })

    // Without an index, the static plugin returns 403 at the root instead of delegating.
    app.get('/', (_request, reply) => reply.sendFile('index.html'))
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url
    // Missing assets must return 404 rather than HTML; otherwise browsers report a
    // MIME type error instead of the actual problem.
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(path)

    if (path.startsWith('/api/') || looksLikeAsset || !hasBuild) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Route inconnue.' } })
    }
    // SPA fallback: react-router handles client-side routes.
    return reply.sendFile('index.html')
  })
}
