import type { FastifyInstance } from 'fastify'
import type { AgentRegistry } from '../../agents/registry.js'
import type { EventLog } from '../../events/event-log.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import type { WebhookService } from '../../webhooks/service.js'
import type { AppContext } from '../context.js'
import { registerDiscoveryRoutes } from './discovery.js'
import { registerMcpRoutes } from './mcp.js'
import { registerProjectCreationRoutes } from './projects.js'
import { registerTaskRoutes } from './tasks.js'

/**
 * Public API under `/api/v1`.
 *
 * Translates task terminology to conversations without replacing anything: a task
 * is an ordinary conversation in the same table and log, visible and resumable in
 * the interface. The authentication hook in `app.ts` ensures entry requires a token.
 */
export function registerV1Routes(
  app: FastifyInstance,
  ctx: AppContext,
  log: EventLog,
  sessions: SessionManager,
  registry: AgentRegistry,
  webhooks: WebhookService,
): void {
  registerDiscoveryRoutes(app, ctx, registry, sessions)
  registerProjectCreationRoutes(app, ctx)
  registerTaskRoutes(app, ctx, log, sessions, registry, webhooks)
  registerMcpRoutes(app, ctx)
}
