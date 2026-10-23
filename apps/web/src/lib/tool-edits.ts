import { countTextChanges } from '@sillage/protocol'
import type { ToolItem } from './chat-fold'
import { parseUnifiedDiff } from './diff'
import { fields, list, text } from './tool-payload'

export interface EditPresentation {
  paths: string[]
  counts: { added: number; removed: number } | null
  scope: 'patch' | 'fragment' | 'replacement' | 'written'
  changes?: unknown[]
  patch?: string
}

/** Codex completion can contain newer changes than the initial call in older journals. */
function changesOf(tool: ToolItem): unknown[] | null {
  const output = tool.output
  if (tool.status === 'done' && Array.isArray(output) && output.length > 0 &&
    output.every(change => text(change, 'path') !== null && text(fields(change)?.kind, 'type') !== null)) return output
  return list(tool.input, 'changes')
}

/** Shared by summaries, counters and expanded views; malformed payloads retain their raw fallback. */
export function toolEdits(tool: ToolItem): EditPresentation | null {
  if (tool.name === 'Write') {
    const path = text(tool.input, 'file_path') ?? text(tool.input, 'path')
    const content = fields(tool.input)?.content
    // Write can overwrite an existing file; its input tells us the lines written, not the net diff.
    return { paths: path ? [path] : [], counts: typeof content === 'string' ? countTextChanges('', content) : null, scope: 'written' }
  }
  if (tool.name !== 'Edit' && tool.name !== 'ApplyPatch') return null
  const changes = changesOf(tool)
  if (changes?.length) {
    const paths = [...new Set(changes.flatMap(change => text(change, 'path') ?? []))]
    let counts: EditPresentation['counts'] = { added: 0, removed: 0 }
    let bytes = 0
    for (const change of changes) {
      const diff = fields(change)?.diff
      const kind = text(fields(change)?.kind, 'type')
      if (typeof diff === 'string') bytes += diff.length
      if (typeof diff !== 'string' || bytes > 1_000_000) { counts = null; break }
      let next: EditPresentation['counts'] = null
      if (kind === 'add') next = countTextChanges('', diff)
      else if (kind === 'delete') next = countTextChanges(diff, '')
      else if (kind === 'update' && (diff === '' || /^@@ /m.test(diff))) {
        const file = parseUnifiedDiff(`diff --git a/file b/file\n${diff}`)[0]!
        next = { added: file.added, removed: file.removed }
      }
      if (!next) { counts = null; break }
      counts.added += next.added
      counts.removed += next.removed
    }
    const readable = changes.every(change => text(change, 'path') !== null && typeof fields(change)?.diff === 'string' && ['add', 'delete', 'update'].includes(text(fields(change)?.kind, 'type') ?? ''))
    return { paths, counts, scope: 'patch', ...(readable ? { changes } : {}) }
  }
  const input = fields(tool.input)
  const path = text(input, 'file_path') ?? text(input, 'path')
  const before = input?.old_string
  const after = input?.new_string
  if (tool.name === 'Edit' && typeof before === 'string' && typeof after === 'string') {
    return { paths: path ? [path] : [], counts: countTextChanges(before, after),
      scope: input?.replace_all === true ? 'replacement' : 'fragment' }
  }
  const patch = text(input, 'patch') ?? text(input, 'diff')
  if (!patch || patch.length > 1_000_000) return path ? { paths: [path], counts: null, scope: 'patch' } : null
  if (patch.startsWith('*** Begin Patch')) {
    const paths: string[] = []
    let added = 0
    let removed = 0
    let counting = false
    let known = true
    for (const line of patch.split(/\r?\n/)) {
      const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
      if (file) {
        paths.push(file[2]!)
        counting = file[1] !== 'Delete'
        // Delete directives carry no previous content, so a total cannot be reconstructed.
        if (file[1] === 'Delete') known = false
      } else if (line.startsWith('*** Move to: ')) paths[paths.length - 1] = line.slice(13)
      else if (counting && line.startsWith('+')) added++
      else if (counting && line.startsWith('-')) removed++
    }
    return { paths: [...new Set(paths)], counts: paths.length && known ? { added, removed } : null, scope: 'patch', patch }
  }
  const files = parseUnifiedDiff(patch.startsWith('diff --git ') ? patch : `diff --git a/${path ?? 'file'} b/${path ?? 'file'}\n${patch}`)
  const counts = files.some(file => file.hunks.length) ? files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 }) : null
  return { paths: path ? [path] : files.map(file => file.path).filter(file => file !== 'file'), counts, scope: 'patch', patch }
}
