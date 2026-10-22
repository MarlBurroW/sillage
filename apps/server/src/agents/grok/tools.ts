import type { EditDiffDto } from '@sillage/protocol'
import { additionDiff, unifiedDiff } from '../../diff-lines.js'
import { toWorkspacePath } from '../paths.js'

/** Normalizes Grok tool names/fields (invariant I3). Grok uses snake_case (`read_file`, `search_replace`, `run_terminal_command`) and fields such as `target_file`; journals use Claude-compatible fields understood by web views and permission prompts. Translate at source, retaining ACP payloads intact in `raw`. Names come from `_meta["x.ai/tool"].name`; ACP `title` is changing prose. Probed on Grok Build 1.0.62. */

type Fields = Record<string, unknown>

export function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Renames known keys and removes Rust input tag `variant`. */
function rename(input: Fields, names: Record<string, string>): Fields {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== 'variant')
      .map(([key, value]) => [names[key] ?? key, value]),
  )
}

const BUILTIN: Record<string, { name: string; input: (input: Fields) => Fields }> = {
  read_file: { name: 'Read', input: (input) => rename(input, { target_file: 'file_path', path: 'file_path' }) },
  search_replace: { name: 'Edit', input: (input) => rename(input, { path: 'file_path' }) },
  write: { name: 'Write', input: (input) => rename(input, { target_file: 'file_path', path: 'file_path' }) },
  run_terminal_command: {
    name: 'Bash',
    input: (input) => rename(input, { is_background: 'run_in_background' }),
  },
  bash: { name: 'Bash', input: (input) => rename(input, { is_background: 'run_in_background' }) },
  grep: { name: 'Grep', input: (input) => rename(input, { query: 'pattern', target_directory: 'path' }) },
  list_dir: { name: 'LS', input: (input) => rename(input, { target_directory: 'path', directory: 'path' }) },
  web_search: { name: 'WebSearch', input: (input) => rename(input, {}) },
  web_fetch: { name: 'WebFetch', input: (input) => rename(input, {}) },
  todo_write: { name: 'TodoWrite', input: (input) => rename(input, {}) },
  spawn_subagent: { name: 'Agent', input: (input) => rename(input, {}) },
  search_tool: { name: 'ToolSearch', input: (input) => rename(input, {}) },
}

/** `ask_user_question` uses its question instead of a tool card, like opencode. */
export const QUESTION_TOOL = 'ask_user_question'

/** Native call name declared by Grok, falling back to ACP titles. */
export function nativeToolName(meta: unknown, title: unknown): string {
  return text(fields(fields(meta)['x.ai/tool']).name) ?? text(title) ?? 'tool'
}

/** Journal tool name/input. Grok searches MCP tools (`search_tool`) then invokes `use_tool` with `server__tool`; normalize to other adapters' `server/tool` with the actual tool input. */
export function describeTool(name: string, rawInput: unknown): { name: string; input: unknown } {
  const input = fields(rawInput)
  if (name === 'use_tool') {
    const target = text(input.tool_name)
    const separator = target?.indexOf('__') ?? -1
    if (target && separator > 0) {
      return { name: `${target.slice(0, separator)}/${target.slice(separator + 2)}`, input: input.tool_input ?? {} }
    }
  }
  const builtin = BUILTIN[name]
  if (builtin) return { name: builtin.name, input: builtin.input(input) }
  return { name, input: rename(input, {}) }
}

/** ACP `diff` block: file and before/after excerpts for edits. */
export interface AcpDiff {
  path: string
  oldText: string | null
  newText: string
}

/** Call-content `diff` blocks in Grok-supplied order. */
export function diffsOf(content: unknown): AcpDiff[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block): AcpDiff[] => {
    const entry = fields(block)
    if (entry.type !== 'diff' || typeof entry.path !== 'string' || typeof entry.newText !== 'string') return []
    return [{ path: entry.path, oldText: typeof entry.oldText === 'string' ? entry.oldText : null, newText: entry.newText }]
  })
}

/** Returned call text as supplied by Grok content blocks. */
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
