import { stat } from 'node:fs/promises'
import type { Db } from '@sillage/db'
import { resolveRealInside } from './workspace.js'
import { readableConversation } from './conversations/access.js'
import { linkedWorktreePaths } from './worktrees/linked.js'
import { notFound } from './http/errors.js'

/** Shared by conversation previews and exports; linked worktrees retain their real-path boundary. */
export async function workspaceImagePath(db: Db, root: string, conversationId: string | null, userId: string, path: string): Promise<string> {
  const existing = async (directory: string): Promise<string | null> => {
    try {
      const absolute = await resolveRealInside(directory, path)
      return (await stat(absolute)).isFile() ? absolute : null
    } catch { return null }
  }
  const primary = await existing(root)
  if (primary) return primary
  if (conversationId) {
    const conversation = readableConversation(db, conversationId, userId)
    if (conversation.projectId) {
      const roots = linkedWorktreePaths(db, conversationId, conversation.projectId)
      const matches = [...new Set((await Promise.all(roots.map(existing))).filter(entry => entry !== null))]
      if (matches.length === 1) return matches[0]!
    }
  }
  throw notFound('file_not_found', 'File not found.')
}
