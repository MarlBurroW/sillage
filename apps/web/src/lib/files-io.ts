import type { FileContentDto } from '@sillage/protocol'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Read and write workspace files. Deliberately outside react-query: tab content edits in place, and
 * background cache replacement would overwrite user input. Tabs decide when to reread.
 */

export function readFile(scope: WorkspaceScope, path: string): Promise<FileContentDto> {
  return api.get<FileContentDto>(
    `${workspaceApiBase(scope)}/file?path=${encodeURIComponent(path)}`,
  )
}

/** Return the new fingerprint. `fingerprint: null` deliberately overwrites. */
export function writeFile(
  scope: WorkspaceScope,
  path: string,
  content: string,
  fingerprint: string | null,
): Promise<{ fingerprint: string }> {
  return api.put<{ fingerprint: string }>(`${workspaceApiBase(scope)}/file`, {
    path,
    content,
    fingerprint,
  })
}

export function rawFileUrl(scope: WorkspaceScope, path: string): string {
  return `${workspaceApiBase(scope)}/file/raw?path=${encodeURIComponent(path)}`
}

/** Stream directly to the browser, including files too large for the editor. */
export function downloadFile(scope: WorkspaceScope, path: string): void {
  startDownload(
    `${workspaceApiBase(scope)}/file/download?path=${encodeURIComponent(path)}`,
    path.split('/').pop() ?? path,
  )
}

/**
 * Directories and selections zipped server-side. One archive rather than one download per file:
 * browsers allow only one per gesture and request unexplained permission for extras. The server
 * determines the filename because only it knows the entries' common directory.
 */
export function downloadArchive(scope: WorkspaceScope, paths: string[]): void {
  const query = paths.map((path) => `path=${encodeURIComponent(path)}`).join('&')
  startDownload(`${workspaceApiBase(scope)}/entries/archive?${query}`, '')
}

function startDownload(href: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  // An HTTP error must not replace the IDE and its drafts.
  anchor.target = '_blank'
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}
