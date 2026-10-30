import { useCallback, useSyncExternalStore } from 'react'
import type { FileContentDto } from '@sillage/protocol'
import { ApiRequestError } from './api'
import { readFile, readFingerprint, writeFile } from './files-io'
import { translate } from './i18n'

interface Document {
  file: FileContentDto | null
  content: string
  loading: boolean
  saving: boolean
  conflict: boolean
  /** Version found on disk during a conflict, which the draft can be compared with. */
  disk: FileContentDto | null
  error: { kind: 'read' | 'write'; message: string } | null
  persisted: Persistence
  /** Bumped when a reread replaces the text, which the editor then applies in place. */
  revision: number
}

/**
 * Where a draft survives. `device` (localStorage) outlives closing the tab or the desktop app:
 * drafts used to live in sessionStorage and vanished with the tab, without warning. `tab`
 * (sessionStorage) survives only a reload, for drafts too large for the device budget below.
 * `memory` lasts as long as the page.
 */
export type Persistence = 'device' | 'tab' | 'memory'

const EMPTY: Document = { file: null, content: '', loading: false, saving: false, conflict: false, disk: null, error: null, persisted: 'device', revision: 0 }
const PREFIX = 'sillage.fileDraft:'
/**
 * Characters drafts may take in localStorage. The origin's quota, about five million, also holds
 * every display preference, and those writes are not guarded: a large draft must not fill it.
 */
const DEVICE_BUDGET = 2_000_000
const documents = new Map<string, Document>()
const listeners = new Set<() => void>()
const recovered = new Set<string>()
const dirty = (document: Document) => document.file !== null && document.content !== document.file.content
const keyOf = (userId: string, scope: string, path: string) => PREFIX + JSON.stringify([userId, scope, path])

/** Storage may be disabled, where even reading `localStorage` throws: drafts then stay in memory. */
function attempt<T>(run: () => T): T | undefined {
  try {
    return run()
  } catch {
    return undefined
  }
}

function storedKeys(): string[] {
  const keys = [...(attempt(() => Object.keys(localStorage)) ?? []), ...(attempt(() => Object.keys(sessionStorage)) ?? [])]
  return [...new Set(keys.filter((key) => key.startsWith(PREFIX)))]
}

/** Size of each draft on the device, measured once rather than reread on every keystroke. */
let deviceSizes: Map<string, number> | null = null

function deviceDrafts(): Map<string, number> {
  deviceSizes ??= new Map(
    (attempt(() => Object.keys(localStorage)) ?? [])
      .filter((key) => key.startsWith(PREFIX))
      .map((key) => [key, attempt(() => localStorage.getItem(key)?.length) ?? 0]),
  )
  return deviceSizes
}

function unstore(key: string) {
  attempt(() => localStorage.removeItem(key))
  attempt(() => sessionStorage.removeItem(key))
  deviceDrafts().delete(key)
}

function persist(key: string, document: Document): Persistence {
  if (!dirty(document) && !document.saving) {
    unstore(key)
    return 'device'
  }
  // Retain the starting version too: restoring must detect agent writes made while the editor was closed.
  const value = JSON.stringify({ file: document.file, content: document.content })
  const sizes = deviceDrafts()
  let others = 0
  for (const [stored, size] of sizes) if (stored !== key) others += size
  if (others + value.length <= DEVICE_BUDGET && attempt(() => { localStorage.setItem(key, value); return true })) {
    sizes.set(key, value.length)
    attempt(() => sessionStorage.removeItem(key))
    return 'device'
  }
  // An older, smaller copy left on the device would come back after closing in place of this one.
  unstore(key)
  return attempt(() => { sessionStorage.setItem(key, value); return true }) ? 'tab' : 'memory'
}

function read(key: string): Document {
  if (!documents.has(key)) {
    let document = EMPTY
    try {
      const stored = JSON.parse(attempt(() => localStorage.getItem(key)) ?? attempt(() => sessionStorage.getItem(key)) ?? 'null')
      if (typeof stored?.content === 'string' && typeof stored.file?.content === 'string' &&
        typeof stored.file?.fingerprint === 'string' && typeof stored.file?.path === 'string' &&
        typeof stored.file?.extension === 'string') document = { ...EMPTY, file: stored.file, content: stored.content }
    } catch { /* Unavailable storage must not prevent editing. */ }
    documents.set(key, document)
  }
  return documents.get(key)!
}

function update(key: string, patch: Partial<Document>) {
  const document = { ...read(key), ...patch }
  document.persisted = persist(key, document)
  documents.set(key, document)
  for (const notify of listeners) notify()
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}

// Only after actual storage failure: closing would lose the only draft copy still held in memory.
// Not for drafts kept in the tab: the desktop app cancels closing silently instead of asking.
window.addEventListener('beforeunload', (event) => {
  if ([...documents.values()].some((document) => dirty(document) && document.persisted === 'memory')) {
    event.preventDefault()
    event.returnValue = ''
  }
})

async function load(key: string, scope: string, path: string, discard: boolean) {
  const before = read(key)
  if (before.loading || before.saving) return
  update(key, { loading: true, error: null })
  try {
    const file = await readFile(scope, path)
    const current = read(key)
    // Editing remains possible while loading. Even explicit discard must preserve text written
    // after it was triggered.
    const replace = current.content === before.content && (discard || !dirty(current))
    if (replace || current.content === file.content) {
      update(key, { file, content: file.content, conflict: false, disk: null, revision: current.revision + (current.content !== file.content ? 1 : 0) })
    } else {
      const changed = current.file?.fingerprint !== file.fingerprint
      update(key, { conflict: changed, disk: changed ? file : null })
    }
  } catch (error) {
    update(key, { error: { kind: 'read', message: error instanceof Error ? error.message : translate('editor.error.read') } })
  } finally { update(key, { loading: false }) }
}

async function save(key: string, scope: string, path: string, force: boolean) {
  const before = read(key)
  if (!before.file || !dirty(before) || before.saving || before.loading) return
  update(key, { saving: true, error: null })
  let stale = false
  try {
    const { fingerprint } = await writeFile(scope, path, before.content, force ? null : before.file.fingerprint)
    // Advance the saved version while retaining current input. Slow replies may arrive after tab
    // changes or new keystrokes.
    update(key, { file: { ...before.file, content: before.content, fingerprint }, conflict: false, disk: null })
  } catch (error) {
    stale = error instanceof ApiRequestError && error.code === 'stale_write'
    if (stale) update(key, { conflict: true })
    else update(key, { error: { kind: 'write', message: error instanceof Error ? error.message : translate('editor.error.write') } })
  } finally { update(key, { saving: false }) }
  // Fetch what is on disk now, so the draft can be compared with it.
  if (stale) await load(key, scope, path, false)
}

/**
 * Reread only if the file changed: called whenever its directory changes, which an agent's turn
 * does many times. A clean document takes the new text; a draft gets its conflict at once rather
 * than at the next save.
 */
async function refresh(key: string, scope: string, path: string) {
  const before = read(key)
  if (!before.file || before.loading || before.saving) return
  // Unreachable server: the next change or return to the page tries again.
  const latest = await readFingerprint(scope, path).then(({ fingerprint }) => fingerprint, () => undefined)
  if (latest === undefined) return
  const current = read(key)
  if (latest === null) {
    // Deleted on disk: say so and keep the text, a draft included; it comes back with the file.
    if (!current.error) update(key, { error: { kind: 'read', message: translate('editor.missing') } })
    return
  }
  if (!current.error && (latest === current.file?.fingerprint || latest === current.disk?.fingerprint)) return
  await load(key, scope, path, false)
}

/**
 * Take the version on disk as the base of the draft, ending the conflict: the comparison then
 * shows the draft against it, and saving checks against it.
 */
function rebase(key: string) {
  const { disk } = read(key)
  if (disk) update(key, { file: disk, disk: null, conflict: false })
}

export function useEditorDocument(userId: string, scope: string, path: string) {
  const key = keyOf(userId, scope, path)
  const document = useSyncExternalStore(subscribe, () => read(key), () => EMPTY)
  const loadDocument = useCallback((discard = false) => load(key, scope, path, discard), [key, scope, path])
  const saveDocument = useCallback((force = false) => save(key, scope, path, force), [key, scope, path])
  const refreshDocument = useCallback(() => refresh(key, scope, path), [key, scope, path])
  return {
    document,
    dirty: dirty(document),
    load: loadDocument,
    save: saveDocument,
    refresh: refreshDocument,
    rebase: () => rebase(key),
    edit: (content: string) => update(key, { content }),
  }
}

/** Closed files remain recoverable without retaining mounted editors. */
export function useEditorDraftPaths(userId: string, scope: string): string[] {
  const prefix = PREFIX + JSON.stringify([userId, scope]).slice(0, -1) + ','
  if (!recovered.has(prefix)) {
    recovered.add(prefix)
    for (const key of storedKeys()) if (key.startsWith(prefix)) read(key)
  }
  const paths = useSyncExternalStore(subscribe, () => JSON.stringify(
    [...documents].filter(([key, document]) => key.startsWith(prefix) && (dirty(document) || document.saving))
      .map(([key]) => (JSON.parse(key.slice(PREFIX.length)) as string[])[2]),
  ), () => '[]')
  return JSON.parse(paths) as string[]
}

/** Document paths in this scope equal to or within `path`. */
function documentsWithin(scope: string, path: string): Array<{ key: string; userId: string; path: string }> {
  return [...documents.keys()].flatMap((key) => {
    const [userId, documentScope, documentPath] = JSON.parse(key.slice(PREFIX.length)) as string[]
    if (documentScope !== scope || userId === undefined || documentPath === undefined) return []
    if (documentPath !== path && !documentPath.startsWith(`${path}/`)) return []
    return [{ key, userId, path: documentPath }]
  })
}

/**
 * Documents follow renamed files, including drafts. A draft retained at the old path would recreate
 * the moved file when saved.
 */
export function moveDocuments(scope: string, from: string, to: string): void {
  for (const entry of documentsWithin(scope, from)) {
    const document = read(entry.key)
    const next = to + entry.path.slice(from.length)
    documents.delete(entry.key)
    try { sessionStorage.removeItem(entry.key) } catch { /* Keep the draft in memory. */ }
    update(keyOf(entry.userId, scope, next), {
      ...document,
      file: document.file && { ...document.file, path: next },
    })
  }
}

/** Whether an unsaved draft belongs to this path: its tab must remain. */
export function hasDraft(scope: string, path: string): boolean {
  return documentsWithin(scope, path).some((entry) => {
    const document = read(entry.key)
    return entry.path === path && (dirty(document) || document.saving)
  })
}

/**
 * Signing out removes the account's drafts from this device: they hold file contents the next
 * person on this browser must not find.
 */
export function forgetDrafts(userId: string): void {
  const prefix = PREFIX + JSON.stringify([userId]).slice(0, -1) + ','
  for (const key of new Set([...storedKeys(), ...documents.keys()])) {
    if (!key.startsWith(prefix)) continue
    unstore(key)
    documents.delete(key)
  }
  for (const scope of recovered) if (scope.startsWith(prefix)) recovered.delete(scope)
  for (const notify of listeners) notify()
}
