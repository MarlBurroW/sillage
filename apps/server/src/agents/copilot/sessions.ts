import type { ClaudeSessionsDto } from '@sillage/protocol'
import { AcpClient } from '../acp/client.js'
import { fields } from '../acp/content.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { samePath } from '../paths.js'
import { agentProcessEnv } from '../process-env.js'
import { copilotProbeLaunch } from './launch.js'

/** Sessions offered for import at once, newest first. */
const LISTED = 40

/**
 * Copilot sessions started in a terminal for one directory, from `session/list`: it needs no
 * sign-in and no model request, and leaves out sessions that never received a prompt (probed on
 * 1.0.116). Copilot titles a session after its first prompt.
 */
export async function listCopilotSessions(binary: string, cwd: string): Promise<ClaudeSessionsDto> {
  const launch = copilotProbeLaunch()
  const client = new AcpClient({ label: 'copilot-sessions', binary, args: launch.args, cwd, env: agentProcessEnv(launch.env), onStderr: () => {} })
  try {
    await client.initialize(CLIENT_INFO)
    const response = fields(await client.request('session/list', { cwd }))
    const sessions = (Array.isArray(response.sessions) ? response.sessions : []).flatMap((item) => {
      const info = fields(item)
      if (typeof info.sessionId !== 'string' || !/^[\w-]+$/.test(info.sessionId)) return []
      // The filter is Copilot's own; a session of another directory must never be adopted here.
      if (typeof info.cwd !== 'string' || !samePath(info.cwd, cwd)) return []
      const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : info.sessionId
      const updated = typeof info.updatedAt === 'string' ? Date.parse(info.updatedAt) : NaN
      return [{ sessionId: info.sessionId, title: title.length > 120 ? `${title.slice(0, 119)}…` : title, firstPrompt: null, gitBranch: null, lastModified: Number.isFinite(updated) ? updated : 0 }]
    })
    return { sessions: sessions.sort((a, b) => b.lastModified - a.lastModified).slice(0, LISTED) }
  } finally { await client.closeAndWait() }
}
