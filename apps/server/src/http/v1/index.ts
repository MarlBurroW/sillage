import type { FastifyInstance } from 'fastify'
import type { AgentRegistry } from '../../agents/registry.js'
import type { EventLog } from '../../events/event-log.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import type { AppContext } from '../context.js'
import { registerDiscoveryRoutes } from './discovery.js'
import { registerTaskRoutes } from './tasks.js'

/**
 * L'API publique, sous `/api/v1`.
 *
 * Elle traduit le vocabulaire de tâche vers les conversations, sans rien remplacer :
 * une tâche est une conversation ordinaire, dans la même table et le même journal,
 * visible et reprenable dans l'interface. Le hook d'authentification de `app.ts`
 * garantit qu'on n'entre ici qu'avec un jeton.
 */
export function registerV1Routes(
  app: FastifyInstance,
  ctx: AppContext,
  log: EventLog,
  sessions: SessionManager,
  registry: AgentRegistry,
): void {
  registerDiscoveryRoutes(app, ctx, registry)
  registerTaskRoutes(app, ctx, log, sessions, registry)
}
