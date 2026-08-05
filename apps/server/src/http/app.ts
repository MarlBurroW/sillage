import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
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
import { registerApiTokenRoutes } from './routes/api-tokens.js'
import { registerV1Routes } from './v1/index.js'
import type { Scheduler } from '../scheduler/scheduler.js'
import type { WebhookService } from '../webhooks/service.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { registerSecretRoutes } from './routes/secrets.js'
import type { SecretStore } from '../secrets/store.js'
import { registerAttachmentRoutes } from './routes/attachments.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerClaudeSessionRoutes } from './routes/claude-sessions.js'
import { registerConversationRoutes } from './routes/conversations.js'
import { registerFileRoutes } from './routes/files.js'
import { registerFsRoutes } from './routes/fs.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerPushRoutes } from './routes/push.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerSystemRoutes } from './routes/system.js'
import { registerTerminalRoutes } from './routes/terminals.js'
import { registerTreeRoutes } from './routes/tree.js'
import { registerUserSettingsRoutes } from './routes/user-settings.js'
import { registerUserRoutes } from './routes/users.js'
import { registerWorktreeRoutes } from './routes/worktrees.js'

/** Routes accessibles sans session. Tout le reste exige un utilisateur. */
const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/health'])

/**
 * L'API publique, réservée aux jetons.
 *
 * La frontière est nette dans les deux sens : un cookie n'y entre pas, un jeton ne sort
 * pas de ce préfixe. C'est ce qui permet aux DTO de l'interface de bouger sans devenir
 * un contrat public, et ce qui interdit à un jeton volé d'atteindre l'administration
 * des comptes.
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
  webhooks: WebhookService,
  scheduler: Scheduler,
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
  await app.register(cookie)
  await app.register(multipart, {
    limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES },
  })

  // Résolution de l'identité sur toute requête. Les routes décident ensuite si elles
  // exigent un utilisateur, via requireUser().
  app.addHook('onRequest', async (request) => {
    const secret = bearerSecret(request.headers.authorization)
    const identity = secret ? resolveApiToken(ctx.db, secret) : null
    if (identity) {
      request.apiToken = identity.token
      request.user = identity.user
      return
    }

    // Repli sur le cookie même en présence d'un en-tête `Authorization` : un proxy ou
    // une extension qui en ajoute un ne doit pas rendre l'interface inutilisable.
    const token = request.cookies[SESSION_COOKIE]
    if (!token) return
    const user = await resolveSession(ctx.db, token)
    if (user) request.user = user
  })

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return
    const path = request.url.split('?')[0] ?? request.url
    if (PUBLIC_ROUTES.has(path) || path === '/api/auth/logout') return

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
  registerProjectRoutes(app, ctx, attachments)
  registerConversationRoutes(app, ctx, log, sessions, registry, attachments, webhooks)
  registerClaudeSessionRoutes(app, ctx, log, sessions, registry)
  registerFsRoutes(app)
  registerAgentRoutes(app, registry, new CliInstaller(ctx.config.paths.agents))
  registerMcpRoutes(app, ctx)
  registerSecretRoutes(app, ctx, secrets)
  registerWorktreeRoutes(app, ctx)
  registerUserRoutes(app, ctx)
  registerApiTokenRoutes(app, ctx, registry)
  registerV1Routes(app, ctx, log, sessions, registry, webhooks)
  registerAttachmentRoutes(app, attachments)
  registerPushRoutes(app, push)
  registerSearchRoutes(app, ctx)
  registerSettingsRoutes(app, ctx, scheduler)
  registerUserSettingsRoutes(app, ctx)
  registerSystemRoutes(app)
  registerTreeRoutes(app, ctx)
  registerFileRoutes(app, ctx)
  registerTerminalRoutes(app, ctx, sessions, terminals)
  await registerWebSocketHub(app, ctx, log, sessions, push)
  // Après le hub : c'est lui qui enregistre le plugin websocket dont dépend le terminal.
  registerTerminalHub(app, ctx, terminals)

  await registerWebClient(app, ctx)

  return app
}

/**
 * Le frontend buildé est servi en statique par le même process (pas de serveur Node
 * front). En développement, Vite sert l'UI et proxifie /api, donc dist/ est absent
 * et on se contente de répondre en JSON.
 */
async function registerWebClient(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const indexPath = join(ctx.config.paths.webRoot, 'index.html')
  const hasBuild = existsSync(indexPath)

  if (hasBuild) {
    await app.register(fastifyStatic, {
      root: ctx.config.paths.webRoot,
      index: false,
      // Le cache-control intégré du plugin écraserait celui posé par setHeaders.
      cacheControl: false,
      /**
       * Seuls les fichiers de `assets/` portent un hash dans leur nom : eux seuls
       * peuvent être figés. Tout le reste (index.html, sw.js, manifest, icônes) garde
       * un nom stable, et un cache immutable y empêcherait toute mise à jour, service
       * worker compris.
       */
      setHeaders: (res, path) => {
        const hashed = path.includes(`${sep}assets${sep}`)
        res.setHeader(
          'cache-control',
          hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        )
      },
    })

    // Sans index, le plugin statique répond 403 sur la racine au lieu de la déléguer.
    app.get('/', (_request, reply) => reply.sendFile('index.html'))
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url
    // Un asset manquant doit répondre 404, pas du HTML : sinon le navigateur remonte
    // une erreur de type MIME au lieu du vrai problème.
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(path)

    if (path.startsWith('/api/') || looksLikeAsset || !hasBuild) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Route inconnue.' } })
    }
    // Repli SPA : react-router gère les routes côté client.
    return reply.sendFile('index.html')
  })
}
