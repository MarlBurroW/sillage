import type { FastifyInstance } from 'fastify'
import type { ClaudeSandboxSupportDto } from '@sillage/protocol'
import type { ClaudeSandboxSupport } from '../../agents/claude/sandbox-support.js'
import { requireUser } from '../require-user.js'

/**
 * Whether this host can run Claude Code's Bash sandbox, for the composer setting that asks for
 * it. Any signed-in user: every conversation owner chooses it. `?refresh=1` checks again after
 * the missing packages were installed.
 */
export function registerClaudeSandboxRoutes(app: FastifyInstance, support: ClaudeSandboxSupport | null): void {
  app.get('/api/agents/claude/sandbox', async (request): Promise<ClaudeSandboxSupportDto> => {
    requireUser(request)
    if (!support) return { state: 'unknown', reason: null, checkedAt: Date.now() }
    return support.read((request.query as { refresh?: string }).refresh === '1')
  })
}
