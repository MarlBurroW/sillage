import { contentText, fields } from '../acp/content.js'

/**
 * Normalizes Copilot ACP tool calls (invariant I3). Copilot 1.0.116 sends no native tool name:
 * only the ACP `kind`, a prose `title` ("Viewing …", "Searching for …") and `rawInput`, whose
 * shape tells the tools apart. Edits arrive as an `apply_patch` string, then as
 * `{fileName, diff}` in the permission request, and close with ACP `diff` blocks.
 */

type Fields = Record<string, unknown>
export interface DescribedTool { name: string; input: Fields; title: string | null }

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/m

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }

function firstPath(update: Fields): string | null {
  return Array.isArray(update.locations) ? text(fields(update.locations[0]).path) : null
}

export function describeCopilotTool(update: Fields): DescribedTool {
  const kind = String(update.kind ?? 'other')
  const title = text(update.title)
  const raw = update.rawInput
  const input = fields(raw)
  const mcp = fields(fields(update._meta).mcp)
  if (typeof mcp.server === 'string' && typeof mcp.tool === 'string') return { name: `${mcp.server}/${mcp.tool}`, input, title: null }

  if (kind === 'execute') {
    // The description is the human label; the title merely repeats the command.
    return { name: 'Bash', input: { command: input.command ?? title ?? '', ...(text(input.description) ? { description: input.description } : {}) }, title: text(input.description) }
  }
  if (kind === 'edit') {
    const patch = typeof raw === 'string' ? raw : text(input.diff) ?? ''
    const header = PATCH_FILE.exec(patch)
    const path = text(input.fileName) ?? header?.[2]?.trim() ?? firstPath(update)
    const created = header?.[1] === 'Add' || title === 'Create file' || /^--- a?\/dev\/null$/m.test(patch)
    return { name: created ? 'Write' : 'Edit', input: { ...(path ? { file_path: path } : {}), ...(patch ? { patch } : {}) }, title: null }
  }
  if (kind === 'fetch') return { name: 'WebFetch', input: { url: input.url ?? '' }, title: null }
  if (typeof input.pattern === 'string') {
    const path = text(input.paths) ?? text(input.path) ?? firstPath(update)
    const grep = 'output_mode' in input || title?.startsWith('Searching') === true
    return { name: grep ? 'Grep' : 'Glob', input: { pattern: input.pattern, ...(path ? { path } : {}), ...(grep && typeof input.output_mode === 'string' ? { output_mode: input.output_mode } : {}) }, title: null }
  }
  if (kind === 'read') {
    const path = text(input.path) ?? firstPath(update)
    return { name: 'Read', input: { ...(path ? { file_path: path } : {}), ...('view_range' in input ? { view_range: input.view_range } : {}) }, title: null }
  }
  // Unrecognized tools keep Copilot's title as the label and their own arguments.
  return { name: title ?? kind, input, title: null }
}

/** What the tool returned: `rawOutput.content` holds the full text, ACP content may be a preview. */
export function outputOf(update: Fields): string {
  const raw = fields(update.rawOutput)
  return typeof raw.content === 'string' ? raw.content : typeof update.rawOutput === 'string' ? update.rawOutput : contentText(update.content)
}
