import { contentText, fields } from '../acp/content.js'

/**
 * Normalizes Copilot ACP tool calls (invariant I3), probed on 1.0.116. The ACP frame carries no
 * tool name: only a `kind`, a prose `title` ("Viewing …", "Searching for …") and `rawInput`. The
 * name, and the server and tool of an MCP call, arrive just before in the `assistant.message`
 * session event (`toolRequests`), which the runner hands over as `native`. Without it (history
 * replayed by `session/load`, or a client that could not subscribe) the shape of the input tells
 * the tools apart.
 *
 * File edits depend on the model: GPT models send one `apply_patch` string, the others `create`
 * and `edit` with their own arguments. The permission request then names the file as
 * `{fileName, diff}`, and the frame closes with ACP `diff` blocks.
 */

type Fields = Record<string, unknown>
export interface DescribedTool { name: string; input: Fields; title: string | null }
/** One entry of `assistant.message.toolRequests`. */
export interface NativeToolRequest { name: string; mcpServer: string | null; mcpTool: string | null }

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/m
/** Copilot ends a shell's output with its own status line, which the exit code already says. */
const SHELL_TRAILER = /<(?:detached command with )?shellId: \S+ completed with exit code -?\d+>\s*$/

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }

function firstPath(update: Fields): string | null {
  return Array.isArray(update.locations) ? text(fields(update.locations[0]).path) : null
}

export function nativeToolRequest(request: unknown): (NativeToolRequest & { toolCallId: string }) | null {
  const entry = fields(request)
  if (typeof entry.toolCallId !== 'string' || typeof entry.name !== 'string') return null
  return { toolCallId: entry.toolCallId, name: entry.name, mcpServer: text(entry.mcpServerName), mcpTool: text(entry.mcpToolName) }
}

/** The native tool behind a frame nothing named, from what only that tool sends. */
function inferName(update: Fields, input: Fields): string | null {
  const kind = update.kind
  if (kind === 'execute') return 'bash'
  if (kind === 'edit') return typeof update.rawInput === 'string' ? 'apply_patch' : 'file_text' in input ? 'create' : 'old_str' in input ? 'edit' : 'apply_patch'
  if (kind === 'fetch') return 'web_fetch'
  if (typeof input.pattern === 'string') return 'output_mode' in input || text(update.title)?.startsWith('Searching') ? 'grep' : 'glob'
  if (typeof input.shellId === 'string' && 'delay' in input) return 'read_bash'
  if (typeof input.agent_type === 'string' && typeof input.prompt === 'string') return 'task'
  if (typeof input.message === 'string' && 'requestedSchema' in input) return 'ask_user'
  if (typeof input.skill === 'string') return 'skill'
  if (typeof input.query === 'string' && typeof input.description === 'string') return 'sql'
  if (kind === 'read' && (typeof input.path === 'string' || firstPath(update))) return 'view'
  return null
}

export function describeCopilotTool(update: Fields, native: NativeToolRequest | null = null): DescribedTool {
  const title = text(update.title)
  const raw = update.rawInput
  const input = fields(raw)
  if (native?.mcpServer && native.mcpTool) return { name: `${native.mcpServer}/${native.mcpTool}`, input, title: null }

  const name = native?.name ?? inferName(update, input)
  switch (name) {
    case 'bash': {
      const description = text(input.description)
      return {
        name: 'Bash',
        // The description is the human label; the title merely repeats the command.
        input: { command: input.command ?? title ?? '', ...(description ? { description } : {}), ...(input.mode === 'async' ? { run_in_background: true } : {}) },
        title: description,
      }
    }
    case 'view': {
      const path = text(input.path) ?? firstPath(update)
      const range = Array.isArray(input.view_range) ? input.view_range.map(Number) : []
      const [start, end] = range
      return {
        name: 'Read',
        input: {
          ...(path ? { file_path: path } : {}),
          ...(Number.isFinite(start) ? { offset: start } : {}),
          // `[start, -1]` reads through the end of the file.
          ...(Number.isFinite(start) && Number.isFinite(end) && end! >= start! ? { limit: end! - start! + 1 } : {}),
        },
        title: null,
      }
    }
    case 'create': {
      const path = text(input.path) ?? text(input.fileName) ?? firstPath(update)
      return { name: 'Write', input: { ...(path ? { file_path: path } : {}), ...(typeof input.file_text === 'string' ? { content: input.file_text } : {}) }, title: null }
    }
    case 'edit': {
      const path = text(input.path) ?? text(input.fileName) ?? firstPath(update)
      return {
        name: 'Edit',
        input: {
          ...(path ? { file_path: path } : {}),
          ...(typeof input.old_str === 'string' ? { old_string: input.old_str } : {}),
          ...(typeof input.new_str === 'string' ? { new_string: input.new_str } : {}),
        },
        title: null,
      }
    }
    case 'apply_patch': {
      const patch = typeof raw === 'string' ? raw : text(input.diff) ?? ''
      const header = PATCH_FILE.exec(patch)
      const path = text(input.fileName) ?? header?.[2]?.trim() ?? firstPath(update)
      const created = header?.[1] === 'Add' || title === 'Create file' || /^--- a?\/dev\/null$/m.test(patch)
      return { name: created ? 'Write' : 'Edit', input: { ...(path ? { file_path: path } : {}), ...(patch ? { patch } : {}) }, title: null }
    }
    case 'grep': {
      const { paths, ...rest } = input
      const path = text(paths) ?? text(input.path) ?? firstPath(update)
      return { name: 'Grep', input: { ...rest, ...(path ? { path } : {}) }, title: null }
    }
    case 'glob': {
      const path = text(input.paths) ?? text(input.path) ?? firstPath(update)
      return { name: 'Glob', input: { pattern: input.pattern ?? '', ...(path ? { path } : {}) }, title: null }
    }
    case 'web_fetch':
      return { name: 'WebFetch', input: { url: input.url ?? '' }, title: null }
    case 'task': {
      const description = text(input.description)
      return {
        name: 'Agent',
        input: {
          ...(description ? { description } : {}),
          prompt: input.prompt ?? '',
          ...(text(input.agent_type) ? { subagent_type: input.agent_type } : {}),
          ...(text(input.name) ? { name: input.name } : {}),
          ...(text(input.model) ? { model: input.model } : {}),
          ...(input.mode === 'background' ? { run_in_background: true } : {}),
        },
        title: description,
      }
    }
    case 'skill':
      return { name: 'Skill', input, title: null }
    case 'sql':
      // Copilot keeps its to-do list in a session database: the description says what a query is for.
      return { name: 'sql', input, title: text(input.description) }
  }
  // Tools without a canonical name keep their own, with Copilot's title as the label.
  const fallback = name ?? title ?? String(update.kind ?? 'other')
  return { name: fallback, input, title: title && title !== fallback ? title : null }
}

/** Exit code of the shell a frame closes, null when it closes none (or the shell still runs). */
export function shellExit(update: Fields): { shellId: string; exitCode: number } | null {
  const contents = fields(update.rawOutput).contents
  for (const item of Array.isArray(contents) ? contents : []) {
    const entry = fields(item)
    if (entry.type === 'shell_exit' && typeof entry.exitCode === 'number') return { shellId: String(entry.shellId ?? ''), exitCode: entry.exitCode }
  }
  return null
}

/** Shell a frame left running in the background, from the ID Copilot gives back. */
export function backgroundShell(update: Fields): string | null {
  const raw = fields(update.rawOutput)
  const shellId = fields(raw.structuredContent).shellId
  return typeof shellId === 'string' && typeof raw.content === 'string' && /^<command started in (?:detached )?background with shellId: /.test(raw.content) ? shellId : null
}

/** Agent a `task` call left running in the background; its events then carry this ID. */
export function backgroundAgent(update: Fields): string | null {
  const content = fields(update.rawOutput).content
  return typeof content === 'string' ? /^Agent started in background with agent_id: ([\w-]+)/.exec(content)?.[1] ?? null : null
}

/**
 * What the tool returned: `rawOutput.content` holds the full text, ACP content may be a preview,
 * and a failed call says why in `rawOutput.message`.
 */
export function outputOf(update: Fields): string {
  const raw = fields(update.rawOutput)
  const output = typeof raw.content === 'string' ? raw.content
    : typeof raw.message === 'string' ? raw.message
    : typeof update.rawOutput === 'string' ? update.rawOutput
    : contentText(update.content)
  return output.replace(SHELL_TRAILER, '')
}
