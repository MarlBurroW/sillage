import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Thread-cited paths known to identify workspace files. Messages render individually with their
 * candidates, but querying individually would create one request per message on conversation open.
 * Gather candidates in a microtask, submit a batch, and feed a shared table: a path cited ten times
 * is checked once. Outside React and the query cache because the key is a growing path set rather
 * than a screen.
 */

/** Must remain below the `filesExistBodySchema` limit. */
const BATCH_LIMIT = 50

interface Resolution {
  /** Paths confirmed as files. */
  readonly files: Set<string>
  /** Previously submitted paths, confirmed or not, to avoid repeat queries. */
  readonly asked: Set<string>
}

const byScope = new Map<string, Resolution>()
const pending = new Map<string, Set<string>>()
const listeners = new Set<() => void>()

const EMPTY: Set<string> = new Set()

function resolutionOf(scope: WorkspaceScope): Resolution {
  const current = byScope.get(scope)
  if (current) return current
  const created: Resolution = { files: new Set(), asked: new Set() }
  byScope.set(scope, created)
  return created
}

function emit(): void {
  for (const listener of listeners) listener()
}

async function flush(scope: WorkspaceScope): Promise<void> {
  const queued = pending.get(scope)
  pending.delete(scope)
  if (!queued || queued.size === 0) return

  const resolution = resolutionOf(scope)
  const paths = [...queued].slice(0, BATCH_LIMIT)
  for (const path of paths) resolution.asked.add(path)

  const answer = await api
    .post<{ files: string[] }>(`${workspaceApiBase(scope)}/files/exist`, { paths })
    // A missing link is not an error to report: the path remains text as before. Keep paths marked
    // requested or each render would repeat the failed query.
    .catch(() => null)
  if (!answer) return

  if (answer.files.length > 0) {
    // Reread after awaiting rather than using the pre-request snapshot: `flush` clears the queue on
    // entry, so batches can overlap for one conversation. Reusing the snapshot would permanently
    // lose files added by the first batch because they are already marked requested.
    const current = resolutionOf(scope)
    // Use a new set rather than mutating: `useSyncExternalStore` compares identity and an in-place
    // addition would trigger no render.
    byScope.set(scope, {
      files: new Set([...current.files, ...answer.files]),
      asked: current.asked,
    })
    emit()
  }

  // The batch hit its cap: remaining paths go in the next batch.
  const overflow = [...queued].slice(BATCH_LIMIT)
  if (overflow.length > 0) {
    request(scope, overflow)
  }
}

/** Queue paths and schedule a batch if none is pending. */
function request(scope: WorkspaceScope, paths: string[]): void {
  const resolution = resolutionOf(scope)
  const fresh = paths.filter((path) => !resolution.asked.has(path))
  if (fresh.length === 0) return

  const queued = pending.get(scope)
  if (queued) {
    for (const path of fresh) queued.add(path)
    return
  }

  pending.set(scope, new Set(fresh))
  // A microtask suffices: all messages in one render submit candidates before it runs.
  void Promise.resolve().then(() => flush(scope))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Scope whose workspace resolves thread paths: the conversation, or the project for previews opened
 * from its panel. Use context rather than props: `Markdown` renders in many places, including
 * release notes and settings previews, with no conversation. Those callers pass nothing and
 * correctly receive no file links.
 */
export const FileLinkContext = createContext<WorkspaceScope | null>(null)

/**
 * Known files for this conversation and submission of missing candidates. Returns an empty set
 * outside conversations, producing no links.
 */
export function useKnownFiles(candidates: Set<string>): Set<string> {
  const scope = useContext(FileLinkContext)

  const files = useSyncExternalStore(
    subscribe,
    () => (scope ? byScope.get(scope)?.files : undefined) ?? EMPTY,
    () => EMPTY,
  )

  // `candidates` is a fresh set after every parse: use its contents as the dependency key or the
  // effect would rerun every render.
  const key = [...candidates].sort().join('\n')
  useEffect(() => {
    if (!scope || key.length === 0) return
    request(scope, key.split('\n'))
  }, [scope, key])

  return files
}
