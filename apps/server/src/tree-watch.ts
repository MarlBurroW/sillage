import { watch, type FSWatcher } from 'node:fs'

/** Watches explorer-visible directories, nonrecursively and only at expanded levels. Recursive inotify across workspaces including `node_modules` would exhaust machine quotas for one repository. Clients declare viewed directories, bounding cost by visible content. Share and reference-count absolute-path watches across tabs and conversations using the same tree. */

/** Writes emit multiple events and `npm install` emits thousands; debounce into one directory reload. */
const DEBOUNCE_MS = 250

interface Shared {
  watcher: FSWatcher
  listeners: Set<() => void>
  timer: NodeJS.Timeout | null
}

const shared = new Map<string, Shared>()

function fire(absolute: string): void {
  const entry = shared.get(absolute)
  if (!entry) return
  entry.timer = null
  for (const listener of entry.listeners) listener()
}

/** Watches directories and returns unsubscribe functions. Missing or unreadable directories produce inert watches rather than errors: clients may request newly deleted levels whose parent watches report removal. */
export function watchDirectory(absolute: string, onChange: () => void): () => void {
  let entry = shared.get(absolute)

  if (!entry) {
    let watcher: FSWatcher
    try {
      watcher = watch(absolute, { persistent: false })
    } catch {
      return () => {}
    }

    const created: Shared = { watcher, listeners: new Set(), timer: null }
    shared.set(absolute, created)
    entry = created

    watcher.on('change', () => {
      if (created.timer) return
      created.timer = setTimeout(() => fire(absolute), DEBOUNCE_MS)
      created.timer.unref()
    })

    // Deleted directories or exhausted inotify limits permanently kill watches.
    // Notify subscribers once more so reloading
    // reveals the disappearance.
    watcher.on('error', () => {
      watcher.close()
      shared.delete(absolute)
      for (const listener of created.listeners) listener()
    })
  }

  const held = entry
  held.listeners.add(onChange)

  return () => {
    held.listeners.delete(onChange)
    if (held.listeners.size > 0) return

    if (held.timer) clearTimeout(held.timer)
    held.watcher.close()
    // Errors may have replaced the current watch in the meantime: remove only
    // the watch still held here.
    if (shared.get(absolute) === held) shared.delete(absolute)
  }
}
