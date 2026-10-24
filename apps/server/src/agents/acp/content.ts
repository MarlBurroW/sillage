import type { EditDiffDto } from '@sillage/protocol'
import { additionDiff, unifiedDiff } from '../../diff-lines.js'
import { toWorkspacePath } from '../paths.js'

type Fields = Record<string, unknown>

export function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** ACP `diff` block: file and before/after excerpts for edits. */
export interface AcpDiff {
  path: string
  oldText: string | null
  newText: string
}

/** Call-content `diff` blocks in agent-supplied order. */
export function diffsOf(content: unknown): AcpDiff[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block): AcpDiff[] => {
    const entry = fields(block)
    if (entry.type !== 'diff' || typeof entry.path !== 'string' || typeof entry.newText !== 'string') return []
    return [{ path: entry.path, oldText: typeof entry.oldText === 'string' ? entry.oldText : null, newText: entry.newText }]
  })
}

/** Returned call text as supplied by ACP content blocks. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const entry = fields(block)
      return entry.type === 'content' ? (text(fields(entry.content).text) ?? '') : ''
    })
    .join('')
}

/** Accumulated command `rawOutput.output` bytes, preserving binary output. Null for noncommands. */
export function commandOutput(rawOutput: unknown): string | null {
  const output = fields(rawOutput)
  if (output.type !== 'Bash' || !Array.isArray(output.output)) return null
  return Buffer.from(output.output.filter((byte): byte is number => typeof byte === 'number')).toString('utf8')
}

/** File changes reconstructed from completion-retained `diff` blocks. Local edits contain only replaced excerpts, yielding partial diffs like Claude `Edit`. */
export function describeEdit(completedRaw: unknown, cwd: string, path: string): EditDiffDto {
  const diffs = (fields(completedRaw).diffs as AcpDiff[] | undefined) ?? []
  const diff = diffs.find((entry) => toWorkspacePath(cwd, entry.path) === path)
  if (!diff) {
    return { path, kind: 'unavailable', patch: '', content: '', partial: false, reason: "Le détail de cet appel n'a pas été conservé." }
  }
  if (diff.oldText === null || diff.oldText === '') {
    return { path, kind: 'patch', patch: additionDiff(path, diff.newText), content: '', partial: false, reason: null }
  }
  return { path, kind: 'patch', patch: unifiedDiff(path, diff.oldText, diff.newText), content: '', partial: true, reason: null }
}
