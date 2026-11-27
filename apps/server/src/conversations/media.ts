import { mkdirSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inArray } from 'drizzle-orm'
import { conversations, type Db } from '@sillage/db'
import { resolveRealInside } from '../workspace.js'
import { readableConversation } from './access.js'

/**
 * Each conversation's media folder: where agents put the images they show (screenshots, renders,
 * charts). Thread images display only from places the server agrees to read, and the only one
 * agents had was the repository, so screenshots were copied into the tree, where they risked
 * being committed and vanished with the worktree, or dropped in the attachments folder, where they
 * never displayed. This folder lives in the data directory, outside every repository, and lasts
 * as long as its conversation.
 */

/** Variable naming the folder in every agent process, for shell commands and scripts. */
export const MEDIA_DIR_ENV = 'SILLAGE_MEDIA_DIR'

/** Beside the other per-feature folders of the data directory, so backups and Docker volumes carry it. */
export function conversationMediaRoot(dataDir: string): string {
  return join(dataDir, 'conversation-media')
}

export function conversationMediaDir(root: string, conversationId: string): string {
  return join(root, conversationId)
}

/** Created before launch: Copilot drops `--add-dir` folders that do not exist, and `cp x "$SILLAGE_MEDIA_DIR/"` needs it. */
export function ensureConversationMediaDir(root: string, conversationId: string): string {
  const dir = conversationMediaDir(root, conversationId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The conversation folder an absolute path points into, with the rest of the path, or null when
 * it points anywhere else. Lexical only: callers still resolve the real path.
 */
function mediaTarget(root: string, path: string): { conversationId: string; rest: string } | null {
  if (!isAbsolute(path)) return null
  const inside = relative(resolve(root), resolve(path))
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
  const [conversationId, ...rest] = inside.split(sep)
  if (!conversationId || rest.length === 0) return null
  return { conversationId, rest: rest.join(sep) }
}

/** Whether `path` names something under the media root, readable or not: such a path is never a workspace file. */
export function isConversationMediaPath(root: string, path: string): boolean {
  return mediaTarget(root, path) !== null
}

/**
 * Real file behind a path in a media folder, for a reader of that folder's conversation. Not only
 * the conversation being read: a fork or a handoff quotes images from its source, and whoever can
 * open the source can see them there anyway. Null for anything else, including symlinks leading
 * out of the folder, so a refusal reveals nothing about other conversations.
 */
export async function conversationMediaFile(db: Db, root: string, userId: string, path: string): Promise<string | null> {
  const target = mediaTarget(root, path)
  if (!target) return null
  try {
    readableConversation(db, target.conversationId, userId)
    const absolute = await resolveRealInside(conversationMediaDir(root, target.conversationId), target.rest)
    return (await stat(absolute)).isFile() ? absolute : null
  } catch {
    return null
  }
}

/** Folders follow their conversations out; files are never shared between two of them. */
export async function removeConversationMedia(root: string, conversationIds: string[]): Promise<void> {
  for (const id of conversationIds) await rm(conversationMediaDir(root, id), { recursive: true, force: true })
}

/**
 * Folders whose conversation no longer exists. Deletions remove their folder themselves; this
 * catches what they cannot, such as a conversation deleted while the server was down or by a
 * path that forgot the folder.
 */
export async function purgeOrphanMedia(db: Db, root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  if (names.length === 0) return 0
  const known = new Set<string>()
  // Bounded batches: SQLite caps bound parameters per statement.
  for (let index = 0; index < names.length; index += 500) {
    const batch = names.slice(index, index + 500)
    for (const row of db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.id, batch)).all()) known.add(row.id)
  }
  const orphans = names.filter((name) => !known.has(name))
  await removeConversationMedia(root, orphans)
  return orphans.length
}
