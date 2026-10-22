import type { EditDiffDto } from '@sillage/protocol'
import type { FileUpdateChange, ThreadItem } from '@sillage/codex-bindings/v2'
import { additionDiff, deletionDiff } from '../../diff-lines.js'
import { toWorkspacePath } from '../paths.js'

/**
 * fileChange edits to a file. Unlike Claude no calculation is needed: items carry per-file unified
 * diffs produced by the CLI when applying patches.
 */
export function describeEdit(completedRaw: unknown, cwd: string, path: string): EditDiffDto {
  const item = (completedRaw as { item?: ThreadItem } | null)?.item
  const changes: FileUpdateChange[] = item?.type === 'fileChange' ? item.changes : []

  const change = changes.find((entry) => toWorkspacePath(cwd, entry.path) === path)
  if (!change) {
    return {
      path,
      kind: 'unavailable',
      patch: '',
      content: '',
      partial: false,
      reason: "Le détail de cet appel n'a pas été conservé.",
    }
  }

  return { path, kind: 'patch', patch: toPatch(path, change), content: '', partial: false, reason: null }
}

/**
 * Updates carry real unified diffs missing only identifying diff --git headers. Creations/deletions
 * carry raw contents; without distinguishing these, creations rendered as empty diffs without
 * hunks.
 */
function toPatch(path: string, change: FileUpdateChange): string {
  if (change.kind.type === 'add') return additionDiff(path, change.diff)
  if (change.kind.type === 'delete') return deletionDiff(path, change.diff)
  return `diff --git a/${path} b/${path}\n${change.diff}`
}
