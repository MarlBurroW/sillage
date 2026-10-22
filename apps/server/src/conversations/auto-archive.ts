import { and, eq, exists, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { conversationReads, conversations, type Db } from '@sillage/db'
import { deleteCheckpoints } from '../checkpoints.js'
import type { Config } from '../config.js'
import { readAppSettings } from '../settings/app-settings.js'
import { resolveConversationCwd } from '../workspace.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Complete archival pass shared by scheduled tasks and 'run now'. Returns archived conversation count or `null` when automatic archiving is disabled. Zero delay also disables manual runs: otherwise it would archive everything read and idle immediately, which clicking does not request. */
export function runArchivePass(db: Db, config: Config): number | null {
  const { autoArchiveDays } = readAppSettings(db, config)
  if (autoArchiveDays === 0) return null

  return archiveStaleConversations(db, autoArchiveDays)
}

/** Archives conversations already read and no longer reopened. Manual actions were insufficient: sidebars overflow through neglect, and an ignored archive menu would fare no better than deletion. Automatic organization therefore uses strict criteria: never archive pinned conversations (`pinned` explicitly protects them); never `running` or `awaiting_input`, which must remain visible; never background work or loops, since `idle` marks turn completion rather than work completion; never conversations unread by their owner, because hiding unread work loses it. Use the owner's cursor rather than every reader's, or absent shared-project users would preserve all conversations forever. Returns archived conversation count. */
export function archiveStaleConversations(db: Db, afterDays: number): number {
  const now = Date.now()

  const ownerCaughtUp = exists(
    db
      .select({ one: sql`1` })
      .from(conversationReads)
      .where(
        and(
          eq(conversationReads.conversationId, conversations.id),
          eq(conversationReads.userId, conversations.userId),
          gte(conversationReads.lastReadSeq, conversations.lastSeq),
        ),
      ),
  )

  // Read candidates before archiving: locating their git snapshots requires knowing
  // which rows changed.
  const stale = db
    .select({ id: conversations.id, projectId: conversations.projectId, worktreeId: conversations.worktreeId })
    .from(conversations)
    .where(
      and(
        isNull(conversations.archivedAt),
        eq(conversations.pinned, false),
        or(eq(conversations.status, 'idle'), eq(conversations.status, 'interrupted')),
        eq(conversations.backgroundCount, 0),
        eq(conversations.loopCount, 0),
        lt(conversations.updatedAt, now - afterDays * DAY_MS),
        ownerCaughtUp,
      ),
    )
    .all()
  if (stale.length === 0) return 0

  const result = db
    .update(conversations)
    .set({ archivedAt: now })
    .where(
      and(
        isNull(conversations.archivedAt),
        inArray(
          conversations.id,
          stale.map((row) => row.id),
        ),
      ),
    )
    .run()

  // Archived conversations have no turns left to undo: remove snapshots without
  // delaying the pass; missing or slow repositories must not fail it.
  void (async () => {
    for (const row of stale) {
      try {
        await deleteCheckpoints(resolveConversationCwd(db, row), row.id)
      } catch {
        // Missing project directory or unusable repository: its refs disappear with it.
      }
    }
  })()

  return result.changes
}
