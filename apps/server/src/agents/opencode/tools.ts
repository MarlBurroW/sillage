import type { ToolPart } from '@sillage/opencode-bindings'
import type { EditDiffDto, SillageEvent } from '@sillage/protocol'
import { additionDiff } from '../../diff-lines.js'
import { toWorkspacePath } from '../paths.js'

/**
 * Normalize opencode tools to journal names/fields (I3).
 *
 * Lowercase tools/camelCase fields (read,filePath) map to Claude-style journal names
 * (Read,file_path), already understood by web/permissions. Translate at source, preserve native raw
 * payload.
 */

type Fields = Record<string, unknown>

function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Rename known keys, preserve unknown ones instead of losing them. */
function rename(input: Fields, names: Record<string, string>): Fields {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [names[key] ?? key, value]))
}

const FILE_KEYS = { filePath: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' }

const BUILTIN: Record<string, { name: string; input: (input: Fields) => Fields }> = {
  bash: { name: 'Bash', input: (input) => rename(input, { workdir: 'cwd' }) },
  read: { name: 'Read', input: (input) => rename(input, FILE_KEYS) },
  edit: { name: 'Edit', input: (input) => rename(input, FILE_KEYS) },
  write: { name: 'Write', input: (input) => rename(input, FILE_KEYS) },
  glob: { name: 'Glob', input: (input) => input },
  grep: { name: 'Grep', input: (input) => input },
  webfetch: { name: 'WebFetch', input: (input) => input },
  websearch: { name: 'WebSearch', input: (input) => input },
  todowrite: { name: 'TodoWrite', input: (input) => input },
  task: { name: 'Agent', input: (input) => input },
  skill: { name: 'Skill', input: (input) => input },
  apply_patch: { name: 'ApplyPatch', input: (input) => rename(input, { patchText: 'patch' }) },
}

/** question tool has no card: question itself replaces it. */
export const QUESTION_TOOL = 'question'

/**
 * Journal call name/input.
 *
 * opencode prefixes MCP tools with server (sillage_read_card): restore server/tool used by other
 * adapters. Only known servers to avoid splitting built-ins containing underscores.
 */
export function describeTool(
  tool: string,
  input: unknown,
  mcpServers: string[],
): { name: string; input: unknown } {
  const builtin = BUILTIN[tool]
  if (builtin) return { name: builtin.name, input: builtin.input(fields(input)) }

  const server = mcpServers
    .filter((name) => tool.startsWith(`${name}_`))
    .sort((a, b) => b.length - a.length)[0]
  if (server) return { name: `${server}/${tool.slice(server.length + 1)}`, input }

  return { name: tool, input }
}

/**
 * Permission display. opencode permission identifies tool family (edit covers
 * edit/write/apply_patch); metadata contains details.
 */
export function describePermission(
  permission: string,
  patterns: string[],
  metadata: unknown,
  cwd: string,
): { toolName: string; input: unknown } {
  const meta = fields(metadata)
  switch (permission) {
    case 'bash':
      return { toolName: 'Bash', input: { command: text(meta.command) ?? patterns.join(' && ') } }
    case 'edit': {
      const path = text(meta.filepath) ?? patterns[0] ?? ''
      return { toolName: 'Edit', input: { file_path: toWorkspacePath(cwd, path), diff: meta.diff } }
    }
    case 'webfetch':
      return { toolName: 'WebFetch', input: { url: text(meta.url) ?? patterns[0] ?? '' } }
    case 'external_directory':
      return { toolName: 'ExternalDirectory', input: { path: text(meta.filepath) ?? patterns[0] ?? '', ...meta } }
    default:
      return { toolName: BUILTIN[permission]?.name ?? permission, input: { patterns, ...meta } }
  }
}

interface PatchedFile {
  path: string
  action: 'created' | 'modified' | 'deleted'
  /** Unified file diff when supplied by opencode. */
  diff: string | null
}

/**
 * Completed-call touched files from metadata.
 *
 * edit/write touch one, apply_patch several. All tolerate missing fields with empty lists instead
 * of invented edits.
 */
function patchedFiles(part: ToolPart): PatchedFile[] {
  if (part.state.status !== 'completed') return []
  const input = fields(part.state.input)
  const meta = fields(part.state.metadata)

  if (part.tool === 'edit') {
    const path = text(fields(meta.filediff).file) ?? text(input.filePath)
    return path ? [{ path, action: 'modified', diff: text(meta.diff) }] : []
  }

  if (part.tool === 'write') {
    const path = text(meta.filepath) ?? text(input.filePath)
    // exists indicates file existed before write.
    return path ? [{ path, action: meta.exists === false ? 'created' : 'modified', diff: null }] : []
  }

  if (part.tool === 'apply_patch' && Array.isArray(meta.files)) {
    return meta.files.flatMap((entry): PatchedFile[] => {
      const file = fields(entry)
      const path = text(file.movePath) ?? text(file.filePath) ?? text(file.relativePath)
      if (!path) return []
      const action = file.type === 'add' ? 'created' : file.type === 'delete' ? 'deleted' : 'modified'
      return [{ path, action, diff: text(file.diff) ?? text(file.patch) }]
    })
  }

  return []
}

/** Completed-call file.edited events. */
export function fileEdits(part: ToolPart, cwd: string): SillageEvent[] {
  return patchedFiles(part).map((file) => ({
    type: 'file.edited',
    toolCallId: part.callID,
    path: toWorkspacePath(cwd, file.path),
    action: file.action,
  }))
}

/**
 * opencode diff starts Index: with absolute paths. Retain sections under display-expected git
 * header.
 */
function toGitPatch(path: string, diff: string): string | null {
  const start = diff.indexOf('\n@@')
  if (start < 0) return diff.startsWith('@@') ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff}` : null
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}${diff.slice(start)}`
}

/** Reconstruct file effect from journaled native part. */
export function describeEdit(completedRaw: unknown, cwd: string, path: string): EditDiffDto {
  const part = (completedRaw as { part?: ToolPart } | null)?.part
  const file = part?.type === 'tool'
    ? patchedFiles(part).find((entry) => toWorkspacePath(cwd, entry.path) === path)
    : undefined

  const patch = file?.diff ? toGitPatch(path, file.diff) : null
  if (patch) return { path, kind: 'patch', patch, content: '', partial: false, reason: null }

  // write supplies content only, no diff: creation displays complete; rewrite shows final content.
  const content = part ? fields(part.state.input).content : undefined
  if (file && part?.tool === 'write' && typeof content === 'string') {
    return file.action === 'created'
      ? { path, kind: 'patch', patch: additionDiff(path, content), content: '', partial: false, reason: null }
      : { path, kind: 'content', patch: '', content, partial: false, reason: null }
  }

  return {
    path,
    kind: 'unavailable',
    patch: '',
    content: '',
    partial: false,
    reason: "Le détail de cet appel n'a pas été conservé.",
  }
}
