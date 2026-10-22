import { statSync } from 'node:fs'
import type { EditDiffDto } from '@sillage/protocol'
import { additionDiff, unifiedDiff } from '../../diff-lines.js'

/**
 * File changes inferred from Claude Code tools.
 *
 * Ideal SDK FileChanged hook (path + add/change/unlink) never fired in 0.3.220 probes with
 * SessionStart watchPaths, even announced cwd. Keep tools, accepting Bash writes (`echo > f`, `sed
 * -i`) absent here. Current panel git state still sees them.
 */

/** Writing tools and their path fields. */
const PATH_FIELDS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * Reconstruct tool file effect from native payload.
 *
 * Claude supplies no previous state: Write gives content without comparison; Edit gives old/new
 * excerpts allowing real diff. Show distinction rather than disguising as full diff.
 */
export function describeEdit(
  startedRaw: unknown,
  path: string,
  action: 'created' | 'modified' | 'deleted',
): EditDiffDto {
  const block = startedRaw as { name?: string; input?: Record<string, unknown> } | null
  const input = block?.input

  if (!input) {
    return empty(path, "Le détail de cet appel n'a pas été conservé.")
  }

  if (block?.name === 'Edit') {
    const before = input.old_string
    const after = input.new_string
    if (typeof before === 'string' && typeof after === 'string') {
      return {
        path,
        kind: 'patch',
        patch: unifiedDiff(path, before, after),
        content: '',
        partial: true,
        reason: null,
      }
    }
  }

  const written = input.content ?? input.new_source
  if (typeof written === 'string') {
    // Creation has no before: everything added, so diff is complete.
    if (action === 'created') {
      return { path, kind: 'patch', patch: additionDiff(path, written), content: '', partial: false, reason: null }
    }
    return {
      path,
      kind: 'content',
      patch: '',
      content: written,
      partial: false,
      reason: "Le fichier a été réécrit en entier : son état précédent n'est pas dans le journal.",
    }
  }

  return empty(path, "Cet appel ne porte pas le contenu écrit.")
}

function empty(path: string, reason: string): EditDiffDto {
  return { path, kind: 'unavailable', patch: '', content: '', partial: false, reason }
}

export function editedPath(toolName: string, input: unknown): string | null {
  const field = PATH_FIELDS[toolName]
  if (!field || typeof input !== 'object' || input === null) return null

  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Whether file already exists.
 *
 * Observe at call start, only time distinguishing creation/rewrite: afterward both exist. Parsing
 * “File created successfully” would hardcode mutable CLI wording.
 *
 * Synchronous deliberately: delayed reads may resolve after write. Local stat costs microseconds;
 * async version also required retaining call until response.
 */
export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
