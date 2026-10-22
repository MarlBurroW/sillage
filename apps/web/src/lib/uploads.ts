import { useSyncExternalStore } from 'react'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from '@sillage/protocol'
import { formatBytes } from './attachments'
import { translate, translateError } from './i18n'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Files dropped in the explorer and uploading to the workspace. Stored outside React, like editor
 * tabs: uploads survive collapsing the column and switching panel tabs, whereas component state
 * would disappear and leave requests running with nothing displaying them. Use `XMLHttpRequest`
 * rather than `fetch`: it is the only browser API reporting upload progress; `fetch` reports
 * downloads only.
 */

export interface Upload {
  id: string
  scope: WorkspaceScope
  /** Destination relative to the working directory. */
  path: string
  /** Displayed name: path from the target directory, locating nested files. */
  label: string
  sizeBytes: number
  sentBytes: number
  status: 'pending' | 'sending' | 'done' | 'error'
  /** Already translated message, present only in `error`. */
  error: string | null
}

/** File from a drop, with its position in the dropped tree. */
export interface DroppedFile {
  file: File
  /** Path relative to the target directory: a simple name or `folder/sub/file`. */
  relativePath: string
}

/**
 * Concurrent uploads. Three rather than one because small-file directory uploads spend most time on
 * round trips. Avoid unlimited concurrency: a hundred progress bars each advancing one percent
 * become meaningless, while the server writes a hundred partial files in parallel.
 */
const CONCURRENCY = 3

/** Delay before a successful upload leaves the list: long enough to notice without getting in the way. */
const KEEP_DONE_MS = 2500

let uploads: Upload[] = []
/**
 * Snapshots per scope, rebuilt on each emission: `useSyncExternalStore` requires unchanged reads to
 * return the exact same object.
 */
let byScope = new Map<WorkspaceScope, Upload[]>()
const EMPTY: Upload[] = []

const listeners = new Set<() => void>()
/** In-flight requests, allowing users to cancel an upload. */
const inFlight = new Map<string, XMLHttpRequest>()
/** Tree refresh callback registered by the displayed scope. */
const refreshers = new Map<WorkspaceScope, Set<() => void>>()

function emit(): void {
  const next = new Map<WorkspaceScope, Upload[]>()
  for (const upload of uploads) {
    const list = next.get(upload.scope)
    if (list) list.push(upload)
    else next.set(upload.scope, [upload])
  }
  byScope = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUploads(scope: WorkspaceScope): Upload[] {
  return useSyncExternalStore(
    subscribe,
    () => byScope.get(scope) ?? EMPTY,
    () => EMPTY,
  )
}

/**
 * Register how to reread a scope's tree after an upload. Server disk watches already report
 * arriving files, but only for expanded levels: dropping into a collapsed directory would otherwise
 * show stale cached contents when opened. Explicit refresh fills this gap.
 */
export function registerTreeRefresh(scope: WorkspaceScope, refresh: () => void): () => void {
  const set = refreshers.get(scope) ?? new Set()
  set.add(refresh)
  refreshers.set(scope, set)
  return () => {
    set.delete(refresh)
    if (set.size === 0) refreshers.delete(scope)
  }
}

function patch(id: string, changes: Partial<Upload>): void {
  uploads = uploads.map((upload) => (upload.id === id ? { ...upload, ...changes } : upload))
  emit()
}

export function dismissUpload(id: string): void {
  inFlight.get(id)?.abort()
  inFlight.delete(id)
  uploads = uploads.filter((upload) => upload.id !== id)
  emit()
}

/** Remove finished uploads from a scope, both successful and failed. */
export function clearSettledUploads(scope: WorkspaceScope): void {
  uploads = uploads.filter(
    (upload) => upload.scope !== scope || (upload.status !== 'done' && upload.status !== 'error'),
  )
  emit()
}

/** Queue and active upload count shared by all scopes. */
const pending: { upload: Upload; file: File }[] = []
let running = 0

/**
 * Queue dropped files for upload to `parent`. Report count-limit rejection as an upload error
 * rather than throwing: the caller would show it elsewhere while the upload list is already
 * visible.
 */
export function enqueueUploads(
  scope: WorkspaceScope,
  parent: string,
  files: DroppedFile[],
): void {
  if (files.length === 0) return

  if (files.length > MAX_UPLOAD_FILES) {
    uploads = [
      ...uploads,
      {
        id: crypto.randomUUID(),
        scope,
        path: parent,
        label: files[0]?.relativePath.split('/')[0] ?? '',
        sizeBytes: 0,
        sentBytes: 0,
        status: 'error',
        error: translate('uploads.tooMany', { count: files.length, max: MAX_UPLOAD_FILES }),
      },
    ]
    emit()
    return
  }

  const queued: Upload[] = files.map(({ file, relativePath }) => {
    const tooLarge = file.size > MAX_UPLOAD_BYTES
    return {
      id: crypto.randomUUID(),
      scope,
      path: parent ? `${parent}/${relativePath}` : relativePath,
      label: relativePath,
      sizeBytes: file.size,
      sentBytes: 0,
      // Reject before uploading: there is no reason to transfer a hundred megabytes only to be rejected afterward.
      status: tooLarge ? 'error' : 'pending',
      error: tooLarge
        ? translate('uploads.tooLarge', {
            name: relativePath,
            max: formatBytes(MAX_UPLOAD_BYTES),
          })
        : null,
    }
  })

  const sources = new Map(queued.map((upload, index) => [upload.id, files[index]?.file as File]))
  uploads = [...uploads, ...queued]
  emit()

  for (const upload of queued) {
    if (upload.status === 'pending') pending.push({ upload, file: sources.get(upload.id) as File })
  }
  pump()
}

function pump(): void {
  while (running < CONCURRENCY && pending.length > 0) {
    const next = pending.shift()
    if (!next) return
    // The entry may have been removed between queueing and its turn.
    if (!uploads.some((upload) => upload.id === next.upload.id)) continue

    running += 1
    void send(next.upload, next.file).finally(() => {
      running -= 1
      pump()
    })
  }
}

async function send(upload: Upload, file: File): Promise<void> {
  patch(upload.id, { status: 'sending' })

  try {
    await put(upload, file)
    patch(upload.id, { status: 'done', sentBytes: upload.sizeBytes })
    for (const refresh of refreshers.get(upload.scope) ?? []) refresh()
    // Once the tree is current, a successful upload has nothing left to report and disappears; an
    // error stays until read.
    setTimeout(() => {
      if (uploads.some((entry) => entry.id === upload.id && entry.status === 'done')) {
        dismissUpload(upload.id)
      }
    }, KEEP_DONE_MS)
  } catch (err) {
    // Cancellation already removes the entry: there is nothing left to mark as failed.
    if (!uploads.some((entry) => entry.id === upload.id)) return
    patch(upload.id, {
      status: 'error',
      error: err instanceof Error ? err.message : translate('uploads.failed'),
    })
  } finally {
    inFlight.delete(upload.id)
  }
}

function put(upload: Upload, file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    inFlight.set(upload.id, request)

    const url = `${workspaceApiBase(upload.scope)}/entries/upload?path=${encodeURIComponent(upload.path)}`
    request.open('POST', url)

    // Let the browser build the multipart `content-type` header, including its boundary: setting it
    // manually would break parsing.
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) patch(upload.id, { sentBytes: event.loaded })
    })

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve()
        return
      }
      reject(errorOf(request))
    })
    request.addEventListener('error', () => reject(new Error(translate('uploads.failed'))))
    request.addEventListener('abort', () => reject(new Error(translate('uploads.cancelled'))))

    const body = new FormData()
    body.append('file', file, file.name)
    request.send(body)
  })
}

/** API error body translated as elsewhere, or the status as fallback. */
function errorOf(request: XMLHttpRequest): Error {
  try {
    const payload = JSON.parse(request.responseText) as {
      error?: { code: string; message: string; params?: Record<string, string | number> }
    }
    const error = payload.error
    if (error) return new Error(translateError(error.code, error.message, error.params))
  } catch {
    // Unreadable response (proxy or disconnect): only the status is available.
  }
  return new Error(translate('error.http', { status: request.status }))
}

/**
 * Files in a drop, with directories expanded. `webkitGetAsEntry` is the only way to read dropped
 * directories: `dataTransfer.files` exposes only their empty, sizeless entry, which caused empty
 * uploads. The name is nonstandard but universally supported in practice. Capture entries before
 * awaiting: the `DataTransfer` list is cleared as soon as the event handler yields.
 */
export async function filesFromDrop(transfer: DataTransfer): Promise<DroppedFile[]> {
  const entries = Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null)

  if (entries.length === 0) {
    // Without the API, or when the drop does not expose it, plain files suffice; directories would
    // not appear there anyway.
    return Array.from(transfer.files).map((file) => ({ file, relativePath: file.name }))
  }

  const collected: DroppedFile[] = []
  for (const entry of entries) await collect(entry, '', collected)
  return collected
}

async function collect(entry: FileSystemEntry, prefix: string, into: DroppedFile[]): Promise<void> {
  // Beyond the cap, further entries would only be rejected: stop walking and let the caller report
  // an oversized drop instead of a truncated one.
  if (into.length > MAX_UPLOAD_FILES) return

  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    })
    // Skip an unreadable file (moved between drop and read) instead of failing the entire batch.
    if (file) into.push({ file, relativePath })
    return
  }

  if (!entry.isDirectory) return

  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // `readEntries` returns one batch of roughly a hundred entries: call it until an empty batch
  // arrives or large directories will be truncated.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]))
    })
    if (batch.length === 0) return
    for (const child of batch) await collect(child, relativePath, into)
  }
}

/** Whether a drag carries files from the operating system rather than a moved explorer entry. */
export function carriesExternalFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files')
}
