import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaudeSessionsDto } from '@sillage/protocol'
import { AcpClient } from '../acp/client.js'
import { fields } from '../acp/content.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { samePath } from '../paths.js'
import { antigravityEnv, userAntigravityHome } from '../../antigravity-accounts/homes.js'
import { antigravityArgs } from './launch.js'

/** Native listing is directory-scoped and does not request model inference. */
export async function listAntigravitySessions(binary: string, cwd: string, home = userAntigravityHome()): Promise<ClaudeSessionsDto> {
  const client = new AcpClient({ label: 'antigravity-sessions', binary, args: antigravityArgs(), cwd, env: antigravityEnv(home, home !== userAntigravityHome()), onStderr: () => {} })
  try {
    await client.initialize(CLIENT_INFO)
    const response = fields(await client.request('session/list', { cwd }))
    const sessions = await Promise.all((Array.isArray(response.sessions) ? response.sessions : []).map(async (item) => {
      const info = fields(item)
      const sessionId = String(info.sessionId)
      if (!/^[\w-]+$/.test(sessionId) || typeof info.cwd !== 'string' || !samePath(info.cwd, cwd)) return null
      const saved = await stat(join(home, 'antigravity-acp', 'conversations', `${sessionId}.db`)).catch(() => null)
      // Empty probe sessions cannot resume a conversation.
      if (!saved?.size) return null
      return { sessionId, title: String(info.title ?? sessionId), firstPrompt: null, gitBranch: null, lastModified: saved.mtimeMs }
    }))
    return { sessions: sessions.filter((item) => item !== null).sort((a, b) => b.lastModified - a.lastModified).slice(0, 40) }
  } finally { await client.closeAndWait() }
}
