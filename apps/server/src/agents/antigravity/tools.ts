import { fields } from '../acp/content.js'

const NAMES: Record<string, string> = {
  view_file: 'Read', read_file: 'Read', client_view_file: 'Read', view_file_outline: 'Read', view_code_item: 'Read',
  replace_file_content: 'Edit', multi_replace_file_content: 'Edit', edit_file: 'Edit', client_edit_file: 'Edit',
  write_to_file: 'Write', write_file: 'Write', create_file: 'Write', client_create_file: 'Write',
  run_command: 'Bash', shell: 'Bash', command_status: 'TaskOutput', send_command_input: 'TaskOutput',
  grep_search: 'Grep', find_by_name: 'Glob', find_file: 'Glob', list_dir: 'LS', list_directory: 'LS',
  search_web: 'WebSearch', read_url_content: 'WebFetch', start_subagent: 'Agent',
  generate_image: 'GenerateImage', task_boundary: 'TaskUpdate',
}
const KEYS: Record<string, string> = {
  AbsolutePath: 'file_path', absolute_path: 'file_path', TargetFile: 'file_path', target_file: 'file_path',
  CommandLine: 'command', command_line: 'command', Cwd: 'cwd', working_dir: 'cwd', SearchPath: 'path', DirectoryPath: 'path',
  Query: 'query', Pattern: 'pattern', Url: 'url', URL: 'url', Content: 'content', CodeContent: 'content',
  TargetContent: 'old_string', ReplacementContent: 'new_string', ReplacementChunks: 'edits',
  StartLine: 'offset', EndLine: 'end_line',
}

/** The wire title is often prose or a shell command. MCP identity comes from metadata. */
export function describeAntigravityTool(update: Record<string, unknown>): { name: string; input: unknown; title: string | null } {
  const meta = fields(update._meta)
  const mcp = fields(meta.mcp)
  let rawInput = update.rawInput
  if (typeof rawInput === 'string') { try { rawInput = JSON.parse(rawInput) } catch { /* Preserve malformed historical input in the raw event. */ } }
  const raw = fields(rawInput)
  const native = String(update.title ?? 'tool').replace(/^Run (.+)\?$/, '$1').replace(/^(Running|Requesting permission for)\s+/, '')
  const name = typeof mcp.tool === 'string' ? `${String(mcp.server ?? 'mcp')}/${mcp.tool}`
    : NAMES[native] ?? ({ execute: 'Bash', read: 'Read', edit: 'Edit', search: 'Grep', fetch: 'WebFetch' } as Record<string, string>)[String(update.kind)] ?? native
  const input = typeof mcp.tool === 'string' ? fields(raw.arguments ?? raw)
    : Object.fromEntries(Object.entries(raw).map(([key, value]) => [KEYS[key] ?? key, value]))
  const action = [raw.toolAction, raw.toolSummary, ...(name === 'Bash' ? [raw.Description, raw.description] : [])].find((value) => typeof value === 'string' && value.trim())
  // Descriptions supplied as arguments to tools creating resources describe the
  // resource, not this action. The harness metadata remains authoritative.
  // Google also falls back to a tool's description/prompt argument in this
  // metadata slot. Those can be the resource being created, not an action label.
  const resourceDescription = name !== 'Bash' && [input.description, input.prompt, input.Description, input.Prompt].includes(meta.prompt)
  const title = typeof meta.prompt === 'string' && !resourceDescription ? meta.prompt
    : typeof mcp.tool === 'string' ? null
    : typeof action === 'string' ? action : name === 'Bash' ? null
    : NAMES[native] ? null : typeof update.title === 'string' ? update.title : null
  if (name === 'Bash' && !input.command && update.kind === 'execute') input.command = native
  if (!input.file_path && Array.isArray(update.locations) && ['Read', 'Edit', 'Write'].includes(name)) input.file_path = fields(update.locations[0]).path
  return { name, input, title }
}
