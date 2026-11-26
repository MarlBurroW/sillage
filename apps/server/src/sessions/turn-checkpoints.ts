import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { projects, type ConversationRow, type Db } from '@sillage/db'
import type { EventLog } from '../events/event-log.js'
import { detach } from '../detach.js'
import { resolveConversationCwd } from '../workspace.js'
import {
  CheckpointError,
  captureSnapshot,
  checkpointRef,
  copyCheckpoints,
  deleteCheckpoints,
  diffCheckpoint,
  moveSnapshot,
  readSnapshot,
  restoreSnapshot,
} from '../checkpoints.js'
import { serialized } from '../git-workflow.js'

/** Open checkpoint for the current turn: before snapshot captured, after snapshot awaiting completion. Retain tool-touched files to distinguish turn work from files introduced by pulls. */
interface ActiveCheckpoint {
  key: string
  cwd: string
  edited: Set<string>
  /** Resolves once the before snapshot exists, false when its capture failed. Turns may start while it runs. */
  capture: Promise<boolean>
}

/** How long a send waits for the before snapshot. Capture takes tens of milliseconds on Linux but seconds on Windows, where every git process is slow: beyond this, the turn starts and the capture finishes alongside. The agent's first write follows a model round trip, so the snapshot still precedes it in practice. */
const CHECKPOINT_WAIT_MS = 1_000

/** Beyond this limit, completion events omit files because conversations cannot display that many. */
const CHECKPOINT_EVENT_FILES = 500

export interface RestoreResult {
  written: number
  deleted: number
  indexRestored: boolean
  skipped: number
}

/** Per-turn workspace snapshots: the before capture at send, the after capture and diff at turn end, restoration, and copies for forks. Busy checks stay with the session manager, which knows which turns run. */
export class TurnCheckpoints {
  private readonly active = new Map<string, ActiveCheckpoint>()

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    /** Conversation working directory; throws for a conversation that no longer exists. */
    private readonly workingDirectory: (conversationId: string) => string,
  ) {}

  /** Records a file a tool touched during the open turn. */
  markEdited(conversationId: string, path: string): void {
    this.active.get(conversationId)?.edited.add(path)
  }

  /** Drops the open checkpoint without capturing anything: the turn never reached the CLI, or the conversation is going away. */
  forget(conversationId: string): void {
    this.active.delete(conversationId)
  }

  /** Captures pre-turn workspace state when enabled. Failure never blocks delivery: snapshots are convenience; turns are the work. Outside git, do nothing silently. */
  async open(conversation: ConversationRow): Promise<void> {
    if (conversation.projectId === null || this.active.has(conversation.id)) return
    const project = this.db
      .select({ turnCheckpoints: projects.turnCheckpoints })
      .from(projects)
      .where(eq(projects.id, conversation.projectId))
      .get()
    if (!project?.turnCheckpoints) return

    const cwd = resolveConversationCwd(this.db, conversation)
    const key = randomUUID()
    const capture = captureSnapshot(cwd, checkpointRef(conversation.id, key, 'before')).then(
      () => true,
      (err: unknown) => {
        if (!(err instanceof CheckpointError && err.code === 'checkpoint_not_repository')) {
          console.warn(`[checkpoints] capture avant le tour impossible (${conversation.id}) :`, err)
        }
        return false
      },
    )
    const entry: ActiveCheckpoint = { key, cwd, edited: new Set(), capture }

    let timer: NodeJS.Timeout | undefined
    const settled = await Promise.race([
      capture,
      new Promise<null>((resolveWait) => {
        timer = setTimeout(() => resolveWait(null), CHECKPOINT_WAIT_MS)
      }),
    ])
    clearTimeout(timer)
    if (settled === false) return

    // Journal the opening now even when the capture is still running: the thread attaches each
    // checkpoint to the next user message, so the marker must precede it.
    this.active.set(conversation.id, entry)
    this.log.append(conversation.id, { type: 'checkpoint.started', key })
    if (settled === null) {
      detach(capture.then((ok) => {
        if (ok || this.active.get(conversation.id) !== entry) return
        this.active.delete(conversation.id)
        this.fail(conversation.id, key, 'The workspace could not be captured before the turn.')
      }), 'late checkpoint capture')
    }
  }

  private fail(conversationId: string, key: string, reason: string): void {
    this.log.append(conversationId, {
      type: 'checkpoint.completed',
      key,
      status: 'failed',
      reason,
      files: [],
      truncated: false,
      excluded: 0,
    })
  }

  /** Captures post-turn state and journals changes without blocking. Remove open checkpoints before capture because queued messages may start another turn needing its own checkpoint meanwhile. */
  close(conversationId: string): void {
    const active = this.active.get(conversationId)
    if (!active) return
    this.active.delete(conversationId)

    void (async () => {
      // A short turn can end before the before snapshot is in: without it there is nothing to diff.
      if (!(await active.capture)) {
        this.fail(conversationId, active.key, 'The workspace could not be captured before the turn.')
        return
      }
      try {
        await captureSnapshot(active.cwd, checkpointRef(conversationId, active.key, 'after'))
        const diff = await diffCheckpoint(active.cwd, conversationId, active.key, [...active.edited])
        this.log.append(conversationId, {
          type: 'checkpoint.completed',
          key: active.key,
          status: 'ready',
          reason: null,
          files: diff.files.slice(0, CHECKPOINT_EVENT_FILES),
          truncated: diff.files.length > CHECKPOINT_EVENT_FILES,
          excluded: diff.excluded,
        })
      } catch (err) {
        this.fail(conversationId, active.key, err instanceof Error ? err.message : String(err))
      }
    })().catch((err: unknown) => {
      // Conversations may disappear during capture, leaving no journal to write.
      console.warn(`[checkpoints] capture après le tour perdue (${conversationId}) :`, err)
    })
  }

  /** Restoration itself, once the caller has checked no turn races it: see `SessionManager.restoreCheckpoint`. */
  async restore(cwd: string, conversationId: string, key: string, options: { undo?: boolean }): Promise<RestoreResult> {
    const undoRef = checkpointRef(conversationId, key, 'undo')
    const result = await serialized(cwd, async () => {
      if (!options.undo) {
        await captureSnapshot(cwd, undoRef)
        return restoreSnapshot(cwd, checkpointRef(conversationId, key, 'before'))
      }
      if (!(await readSnapshot(cwd, undoRef))) {
        throw new CheckpointError('checkpoint_missing', 'There is no restoration of this turn to undo.')
      }
      // Undoing is a restoration too: keep what it replaces, then make that the next undo point.
      const swap = `${undoRef}-next`
      await captureSnapshot(cwd, swap)
      const restored = await restoreSnapshot(cwd, undoRef)
      await moveSnapshot(cwd, swap, undoRef)
      return restored
    })
    this.log.append(conversationId, {
      type: 'checkpoint.restored',
      key,
      written: result.written,
      deleted: result.deleted,
      skipped: result.skipped,
      undoable: !options.undo,
      undone: options.undo === true,
    })
    return result
  }

  /** Gives forks source snapshots so copied journal markers resolve. */
  async inherit(fromId: string, toId: string): Promise<void> {
    try {
      await copyCheckpoints(this.workingDirectory(toId), fromId, toId)
    } catch (err) {
      console.warn(`[checkpoints] copie au fork impossible (${fromId} -> ${toId}) :`, err)
    }
  }

  /** Removes deleted/archived conversation snapshots without blocking. */
  async drop(conversationId: string): Promise<void> {
    this.active.delete(conversationId)
    try {
      await deleteCheckpoints(this.workingDirectory(conversationId), conversationId)
    } catch (err) {
      console.warn(`[checkpoints] nettoyage impossible (${conversationId}) :`, err)
    }
  }
}
