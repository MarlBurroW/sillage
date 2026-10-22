import { useCallback, useSyncExternalStore } from 'react'
import type { FileContentDto } from '@sillage/protocol'
import { ApiRequestError } from './api'
import { readFile, writeFile } from './files-io'
import { translate } from './i18n'

interface Document {
  file: FileContentDto | null
  content: string
  loading: boolean
  saving: boolean
  conflict: boolean
  error: { kind: 'read' | 'write'; message: string } | null
  persisted: boolean
  /** Only rereads replacing text should remount CodeMirror. */
  revision: number
}

const EMPTY: Document = { file: null, content: '', loading: false, saving: false, conflict: false, error: null, persisted: true, revision: 0 }
const PREFIX = 'sillage.fileDraft:'
const documents = new Map<string, Document>()
const listeners = new Set<() => void>()
const recovered = new Set<string>()
const dirty = (document: Document) => document.file !== null && document.content !== document.file.content
const keyOf = (userId: string, scope: string, path: string) => PREFIX + JSON.stringify([userId, scope, path])

function read(key: string): Document {
  if (!documents.has(key)) {
    let document = EMPTY
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null')
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
  try {
    // Retain the starting version too: restoring must detect agent writes made while the editor was closed.
    if (dirty(document) || document.saving) sessionStorage.setItem(key, JSON.stringify({ file: document.file, content: document.content }))
    else sessionStorage.removeItem(key)
    document.persisted = true
  } catch { document.persisted = false }
  documents.set(key, document)
  for (const notify of listeners) notify()
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}

// Only after actual storage failure: closing would lose the only draft copy still held in memory.
window.addEventListener('beforeunload', (event) => {
  if ([...documents.values()].some((document) => dirty(document) && !document.persisted)) {
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
      update(key, { file, content: file.content, conflict: false, revision: current.revision + (current.content !== file.content ? 1 : 0) })
    } else {
      update(key, { conflict: current.file?.fingerprint !== file.fingerprint })
    }
  } catch (error) {
    update(key, { error: { kind: 'read', message: error instanceof Error ? error.message : translate('editor.error.read') } })
  } finally { update(key, { loading: false }) }
}

async function save(key: string, scope: string, path: string, force: boolean) {
  const before = read(key)
  if (!before.file || !dirty(before) || before.saving || before.loading) return
  update(key, { saving: true, error: null })
  try {
    const { fingerprint } = await writeFile(scope, path, before.content, force ? null : before.file.fingerprint)
    // Advance the saved version while retaining current input. Slow replies may arrive after tab
    // changes or new keystrokes.
    update(key, { file: { ...before.file, content: before.content, fingerprint }, conflict: false })
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'stale_write') update(key, { conflict: true })
    else update(key, { error: { kind: 'write', message: error instanceof Error ? error.message : translate('editor.error.write') } })
  } finally { update(key, { saving: false }) }
}

export function useEditorDocument(userId: string, scope: string, path: string) {
  const key = keyOf(userId, scope, path)
  const document = useSyncExternalStore(subscribe, () => read(key), () => EMPTY)
  const loadDocument = useCallback((discard = false) => load(key, scope, path, discard), [key, scope, path])
  const saveDocument = useCallback((force = false) => save(key, scope, path, force), [key, scope, path])
  return {
    document,
    dirty: dirty(document),
    load: loadDocument,
    save: saveDocument,
    edit: (content: string) => update(key, { content }),
  }
}

/** Closed files remain recoverable without retaining mounted editors. */
export function useEditorDraftPaths(userId: string, scope: string): string[] {
  const prefix = PREFIX + JSON.stringify([userId, scope]).slice(0, -1) + ','
  if (!recovered.has(prefix)) {
    recovered.add(prefix)
    try {
      for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) read(key)
    } catch { /* In-memory drafts remain available. */ }
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
