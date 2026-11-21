import { readFileSync, writeFileSync } from 'node:fs'
import { tryExclusiveLock } from '@sillage/db'

/**
 * One daemon per database. A second one (a `pnpm dev` run by an agent without SILLAGE_DATA_DIR,
 * a manual `node main.js`) used to migrate the live database to its branch's schema, journal
 * every running session as interrupted, expire pending prompts, and either exit on the busy port
 * or keep running every scheduled task twice.
 *
 * Node has no portable file lock, but SQLite does: a sidecar database held in an exclusive
 * transaction for the life of the process. The operating system releases it when the process
 * dies, crash included, on Linux, macOS and Windows alike.
 */
export class InstanceLockError extends Error {
  constructor(readonly lockFile: string, readonly holder: LockHolder | null) {
    super(
      `Another Sillage server already uses this database (${lockFile.replace(/\.instance-lock$/, '')})` +
        (holder ? `: pid ${holder.pid}, started ${new Date(holder.startedAt).toISOString()}, version ${holder.version}.` : '.') +
        ' Stop it first, or give this one its own SILLAGE_DATA_DIR.',
    )
    this.name = 'InstanceLockError'
  }
}

export interface LockHolder {
  pid: number
  startedAt: number
  version: string
  /** What took the lock: the daemon, or a command such as `migrate`. */
  role: string
}

export interface InstanceLock {
  release(): void
}

/**
 * Takes the lock of the database at `databasePath`, waiting up to `waitMs` for a previous holder
 * to exit: a restart may start the new process while the old one is still shutting down.
 */
export async function acquireInstanceLock(
  databasePath: string,
  options: { role: string; version: string; waitMs?: number },
): Promise<InstanceLock> {
  const lockFile = `${databasePath}.instance-lock`
  const deadline = Date.now() + (options.waitMs ?? 15_000)
  for (;;) {
    const held = tryExclusiveLock(lockFile)
    if (held) {
      const holder: LockHolder = { pid: process.pid, startedAt: Date.now(), version: options.version, role: options.role }
      // Informative only, for the message the next contender prints; the lock is the transaction.
      try {
        writeFileSync(`${lockFile}.json`, JSON.stringify(holder))
      } catch {
        // A read-only directory still gets the lock.
      }
      return { release: () => held.close() }
    }
    if (Date.now() >= deadline) throw new InstanceLockError(lockFile, readHolder(lockFile))
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function readHolder(lockFile: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(`${lockFile}.json`, 'utf8')) as LockHolder
  } catch {
    return null
  }
}
