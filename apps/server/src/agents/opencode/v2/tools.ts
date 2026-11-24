import type { EditDiffDto, SillageEvent } from '@sillage/protocol'
import { additionDiff } from '../../../diff-lines.js'
import { toWorkspacePath } from '../../paths.js'
import { fields, mcpToolName, rename, text, toGitPatch, type Fields } from '../tools.js'

/**
 * OpenCode 2 tools in journal terms, like `../tools.ts` for 1.x.
 *
 * 2.x renamed several tools and fields (probed 2.4.1): `bash` became `shell`, `task` became
 * `subagent`, and file tools take `path` instead of `filePath`. Journal names stay the
 * Claude-style ones the web and permissions already understand.
 */

const FILE_KEYS = { path: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' }

const BUILTIN: Record<string, { name: string; input: (input: Fields) => Fields }> = {
  shell: { name: 'Bash', input: (input) => rename(input, { workdir: 'cwd' }) },
  read: { name: 'Read', input: (input) => rename(input, FILE_KEYS) },
  edit: { name: 'Edit', input: (input) => rename(input, FILE_KEYS) },
  write: { name: 'Write', input: (input) => rename(input, FILE_KEYS) },
  glob: { name: 'Glob', input: (input) => input },
  grep: { name: 'Grep', input: (input) => input },
  webfetch: { name: 'WebFetch', input: (input) => input },
  websearch: { name: 'WebSearch', input: (input) => input },
  subagent: { name: 'Agent', input: (input) => rename(input, { agent: 'subagent_type' }) },
  skill: { name: 'Skill', input: (input) => rename(input, { name: 'skill' }) },
  apply_patch: { name: 'ApplyPatch', input: (input) => rename(input, { patchText: 'patch' }) },
}

/** The question tool has no card: the form it opens replaces it. */
export const QUESTION_TOOL = 'question'

/** Launches subagents; its call metadata names the child session. */
export const SUBAGENT_TOOL = 'subagent'

export function describeTool(tool: string, input: unknown, mcpServers: string[]): { name: string; input: unknown } {
  const builtin = BUILTIN[tool]
  if (builtin) return { name: builtin.name, input: builtin.input(fields(input)) }
  return { name: mcpToolName(tool, mcpServers), input }
}

/**
 * Permission display. 2.x names the tool family in `action` (`edit` covers edit/write/patch) and
 * puts the planned change in metadata: `files[]` with a unified patch for edits.
 */
export function describePermission(
  action: string,
  resources: string[],
  metadata: unknown,
  cwd: string,
): { toolName: string; input: unknown } {
  const meta = fields(metadata)
  switch (action) {
    case 'shell':
      return { toolName: 'Bash', input: { command: text(meta.command) ?? resources.join(' && ') } }
    case 'edit': {
      const file = Array.isArray(meta.files) ? fields(meta.files[0]) : {}
      const path = text(file.file) ?? resources[0] ?? ''
      return { toolName: 'Edit', input: { file_path: toWorkspacePath(cwd, path), diff: text(file.patch) ?? undefined } }
    }
    case 'webfetch':
      return { toolName: 'WebFetch', input: { url: text(meta.url) ?? resources[0] ?? '' } }
    case 'external_directory':
      return { toolName: 'ExternalDirectory', input: { path: resources[0] ?? '', ...meta } }
    default:
      return { toolName: BUILTIN[action]?.name ?? action, input: { resources, ...meta } }
  }
}

/**
 * What a call needs to describe its file effects: the native result plus the call it answers,
 * since 2.x result events no longer repeat their input. Journaled as `tool.completed` raw.
 */
export interface CompletedCall {
  tool: string
  input: unknown
  metadata: unknown
  output: string
}

interface PatchedFile {
  path: string
  action: 'created' | 'modified' | 'deleted'
  diff: string | null
}

function patchedFiles(call: CompletedCall): PatchedFile[] {
  const meta = fields(call.metadata)
  // Edits report `files[]` with status and patch (probed 2.4.1).
  if (Array.isArray(meta.files)) {
    return meta.files.flatMap((entry): PatchedFile[] => {
      const file = fields(entry)
      const path = text(file.file)
      if (!path) return []
      const status = text(file.status)
      const action = status === 'added' || status === 'created' ? 'created' : status === 'deleted' ? 'deleted' : 'modified'
      return [{ path, action, diff: text(file.patch) }]
    })
  }
  // Writes report nothing but their message: "Created file successfully: x" for a new file.
  if (call.tool === 'write') {
    const path = text(fields(call.input).path)
    return path ? [{ path, action: /^Created\b/.test(call.output) ? 'created' : 'modified', diff: null }] : []
  }
  return []
}

export function fileEdits(toolCallId: string, call: CompletedCall, cwd: string): SillageEvent[] {
  return patchedFiles(call).map((file) => ({
    type: 'file.edited',
    toolCallId,
    path: toWorkspacePath(cwd, file.path),
    action: file.action,
  }))
}

/** Reconstruct a file effect from a journaled `CompletedCall`. */
export function describeEdit(completedRaw: unknown, cwd: string, path: string): EditDiffDto | null {
  const call = (completedRaw as { call?: CompletedCall } | null)?.call
  if (!call) return null
  const file = patchedFiles(call).find((entry) => toWorkspacePath(cwd, entry.path) === path)
  const patch = file?.diff ? toGitPatch(path, file.diff) : null
  if (patch) return { path, kind: 'patch', patch, content: '', partial: false, reason: null }

  const content = fields(call.input).content
  if (file && call.tool === 'write' && typeof content === 'string') {
    return file.action === 'created'
      ? { path, kind: 'patch', patch: additionDiff(path, content), content: '', partial: false, reason: null }
      : { path, kind: 'content', patch: '', content, partial: false, reason: null }
  }
  return null
}

/** Text of a tool result: 2.x returns content blocks, files are named rather than inlined. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const entry = fields(block)
      if (entry.type === 'text') return text(entry.text) ?? ''
      return text(entry.name) ?? text(entry.uri) ?? ''
    })
    .filter(Boolean)
    .join('\n')
}
