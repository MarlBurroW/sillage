import { BROWSER_MCP_SERVER_NAME, CODEX_BUILTIN_MCP_SERVER_NAME, type ToolPresentation } from '@sillage/protocol'
import { fields, flag, text, outputText, scalar } from './tool-payload'
import { toolWebInput } from './tool-web-input'
import { toolEdits, type EditPresentation } from './tool-edits'
import type { ToolItem } from './chat-fold'
import { translate, type MessageKey } from './i18n'
import { EFFORT_KEYS } from './effort-labels'

export type ToolOrigin = { kind: 'native' | 'sillage' | 'mcp'; server: string; name: string }

/** Les adaptateurs normalisent OpenCode en serveur/outil ; les anciens journaux restent lisibles. */
export function toolOrigin(name: string, presentation?: ToolPresentation): ToolOrigin {
  if (presentation?.origin === 'native') return { kind: 'native', server: '', name }
  // These slash namespaces belong to the Codex adapter, not to MCP servers.
  if (presentation?.origin !== 'mcp' && /^(Collaboration|Codex|Hook)\//.test(name)) return { kind: 'native', server: '', name }
  const claude = /^mcp__([^]+?)__(.+)$/.exec(name)
  const slash = /^([^/]+)\/(.+)$/.exec(name)
  const legacy = name.startsWith('sillage_') ? ['','sillage',name.slice(8)] : null
  const match = claude ?? slash ?? legacy
  return match ? { kind: SILLAGE_SERVERS.has(match[1]!) ? 'sillage' : 'mcp', server: match[1]!, name: match[2]! }
    : { kind: 'native', server: '', name }
}
// The agent browser is Sillage's own server too, even though its tools come from Playwright MCP.
// `server` stays as received so browser-specific affordances can still tell it apart.
const SILLAGE_SERVERS = new Set(['sillage', CODEX_BUILTIN_MCP_SERVER_NAME, BROWSER_MCP_SERVER_NAME])
const isBrowser = (origin: ToolOrigin) => origin.server === BROWSER_MCP_SERVER_NAME
// Playwright MCP's tool names, pinned with PLAYWRIGHT_MCP_VERSION; an unlisted one keeps its derived name.
const BROWSER_LABELS: Record<string, MessageKey> = {
  browser_navigate: 'browserTool.navigate',
  browser_navigate_back: 'browserTool.navigate_back',
  browser_click: 'browserTool.click',
  browser_hover: 'browserTool.hover',
  browser_drag: 'browserTool.drag',
  browser_drop: 'browserTool.drop',
  browser_type: 'browserTool.type',
  browser_press_key: 'browserTool.press_key',
  browser_fill_form: 'browserTool.fill_form',
  browser_select_option: 'browserTool.select_option',
  browser_file_upload: 'browserTool.file_upload',
  browser_handle_dialog: 'browserTool.handle_dialog',
  browser_snapshot: 'browserTool.snapshot',
  browser_take_screenshot: 'browserTool.take_screenshot',
  browser_find: 'browserTool.find',
  browser_wait_for: 'browserTool.wait_for',
  browser_console_messages: 'browserTool.console_messages',
  browser_network_requests: 'browserTool.network_requests',
  browser_network_request: 'browserTool.network_request',
  browser_evaluate: 'browserTool.evaluate',
  browser_run_code_unsafe: 'browserTool.run_code_unsafe',
  browser_tabs: 'browserTool.tabs',
  browser_resize: 'browserTool.resize',
  browser_emulate_media: 'browserTool.emulate_media',
  browser_close: 'browserTool.close',
}
// Reading the page informs the agent; acting on it changes nothing in the repository.
const BROWSER_INSPECT = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_find', 'browser_console_messages', 'browser_network_requests', 'browser_network_request'])
const SILLAGE_LABELS: Record<string, MessageKey> = {
  rename_session: 'sillageTool.rename_session',
  move_session: 'sillageTool.move_session',
  search_history: 'sillageTool.search_history',
  read_conversation: 'sillageTool.read_conversation',
  list_sessions: 'sillageTool.list_sessions',
  work_log: 'sillageTool.work_log',
  find_file_edits: 'sillageTool.find_file_edits',
  list_cards: 'sillageTool.list_cards',
  read_card: 'sillageTool.read_card',
  add_card_note: 'sillageTool.add_card_note',
  move_card: 'sillageTool.move_card',
  update_card: 'sillageTool.update_card',
  create_card: 'sillageTool.create_card',
  request_decision: 'sillageTool.request_decision',
  withdraw_decision: 'sillageTool.withdraw_decision',
  update_issue: 'sillageTool.update_issue',
  list_actions: 'sillageTool.list_actions',
  register_action: 'sillageTool.register_action',
  remove_action: 'sillageTool.remove_action',
  run_action: 'sillageTool.run_action',
  create_automation: 'sillageTool.create_automation',
  start_session: 'sillageTool.start_session',
  create_worktree: 'sillageTool.create_worktree',
  list_worktrees: 'sillageTool.list_worktrees',
  remove_worktree: 'sillageTool.remove_worktree',
  schedule_task: 'sillageTool.schedule_task',
  list_models: 'sillageTool.list_models',
  set_project_image: 'sillageTool.set_project_image',
  send_session_message: 'sillageTool.send_session_message',
  broadcast_session_message: 'sillageTool.broadcast_session_message',
  notify_when_done: 'sillageTool.notify_when_done',
  read_session_messages: 'sillageTool.read_session_messages',
  read_instructions: 'sillageTool.read_instructions',
  edit_instructions: 'sillageTool.edit_instructions',
  write_instructions: 'sillageTool.write_instructions',
  read_memory: 'sillageTool.read_memory',
  write_memory: 'sillageTool.write_memory',
  delete_memory: 'sillageTool.delete_memory',
  count_active_sessions: 'sillageTool.count_active_sessions',
  read_session: 'sillageTool.read_session',
  wait_for_session: 'sillageTool.wait_for_session',
  message_session: 'sillageTool.message_session',
  steer_session: 'sillageTool.steer_session',
  interrupt_session: 'sillageTool.interrupt_session',
  reply_session: 'sillageTool.reply_session',
  list_projects: 'sillageTool.list_projects'
}

export function toolLabel(name: string, presentation?: ToolPresentation): string {
  const origin = toolOrigin(name, presentation)
  const key = origin.kind !== 'sillage' ? undefined : isBrowser(origin) ? BROWSER_LABELS[origin.name] : SILLAGE_LABELS[origin.name]
  if (key) return translate(key)
  // Connector action names label the operation; they must not hide its query/target summary.
  if (presentation?.label?.trim()) return presentation.label.trim()
  // Aucun sens inventé pour un serveur inconnu : on enlève seulement le préfixe et les séparateurs.
  return origin.kind === 'native' ? name : origin.name.replace(/[_-]+/g, ' ')
}
export type ToolIntent = 'context' | 'inspect' | 'change' | 'verify' | 'other'
export const INTENT_LABELS: Record<ToolIntent, MessageKey> = {
  context: 'toolStyle.context', inspect: 'toolStyle.inspect', change: 'toolStyle.change', verify: 'toolStyle.verify', other: 'toolStyle.other',
}
export function toolIntent(tool: ToolItem): ToolIntent {
  const origin = toolOrigin(tool.name, tool.presentation)
  if (isBrowser(origin)) return BROWSER_INSPECT.has(origin.name) ? 'inspect' : 'other'
  if (origin.kind === 'sillage') {
    if (/^(read|list|search|find|count)_/.test(origin.name)) return 'context'
    return 'change'
  }
  if (['Read','Glob','Grep','LS','WebFetch','WebSearch','ViewImage'].includes(tool.name)) return 'inspect'
  if (['Edit','Write','ApplyPatch','NotebookEdit'].includes(tool.name)) return 'change'
  // Une commande arbitraire n’est pas une vérification.
  if (tool.name === 'Bash' && /(?:^|[\s:])(?:test|typecheck|lint|check)(?:$|[\s:])/.test(String((tool.input as { command?: unknown } | null)?.command ?? ''))) return 'verify'
  return 'other'
}

/** Aperçu borné, sans charger les sorties complètes ni sérialiser des objets volumineux. */
export function toolPreview(tool: ToolItem): string {
  if (tool.status === 'running') return translate('toolStyle.outputPending')
  const output = outputText(tool.output, 500)
  if (typeof output === 'string' && output.slice(0,500).trim()) return output.slice(0,500).replace(/\s+/g,' ').trim()
  return translate('toolStyle.outputEmpty')
}

/** One-line identifiers for the normalized payloads produced by all adapters. */
export function toolSummary(tool: ToolItem, edits: EditPresentation | null = toolEdits(tool)): { text: string; mono: boolean } | null {
  const input = fields(toolWebInput(tool))
  // Only known descriptive arguments are activity metadata. A card/task's description is its body.
  const description = ['Bash', 'Agent', 'Task'].includes(tool.name) ? text(input, 'description')?.trim() : null
  const title = tool.title?.trim() || description || tool.presentation?.title?.trim()
  if (title) return { text: title, mono: false }
  if (tool.name === 'Bash') {
    const action = commandSummary(input?.commandActions)
    if (action) return { text: action, mono: false }
  }
  if (edits?.paths.length) return { text: edits.paths.join(' · '), mono: true }
  const web = tool.name === 'WebSearch' || tool.name === 'WebFetch'
  if (web && Array.isArray(input?.queries) && input.queries.length > 0) {
    const queries = input.queries.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (queries.length) return { text: queries.join(' · '), mono: true }
  }
  const subject = ['TaskCreate', 'TaskUpdate'].includes(tool.name) ? text(input, 'subject') : null
  if (subject) return { text: subject, mono: false }
  if (tool.name === 'Sleep' && typeof input?.durationMs === 'number' && Number.isFinite(input.durationMs)) {
    return { text: translate('tool.summary.sleep', { seconds: input.durationMs / 1000 }), mono: false }
  }
  const keys = web && input?.type === 'findInPage' ? ['pattern', 'query', 'url']
    : web && input?.type === 'openPage' ? ['url', 'query']
    : tool.name === 'Bash' ? ['command']
    : tool.name === 'Skill' ? ['skill', 'name']
    : tool.name.startsWith('Hook/') ? ['source']
    : ['TaskGet', 'TaskUpdate', 'TaskStop', 'TaskOutput'].includes(tool.name) ? ['taskId', 'task_id', 'id']
    : ['ReadMcpResource', 'ReadMcpResourceDir'].includes(tool.name) ? ['uri', 'server']
    : tool.name === 'Grep' || tool.name === 'Glob' ? ['pattern', 'query', 'path']
    : tool.name === 'WebFetch' ? ['url', 'query']
    : tool.name === 'WebSearch' ? ['query', 'pattern', 'url']
    // Playwright MCP's `element` is the human description of what it clicks or types into.
    : isBrowser(toolOrigin(tool.name, tool.presentation)) ? ['url', 'element', 'key', 'text', 'filename']
    : ['file_path', 'path', 'notebook_path', 'file', 'title', 'subject', 'query', 'pattern', 'skill', 'url', 'uri', 'command', 'prompt', 'card_number', 'number', 'issue_number', 'conversation_id', 'name']
  for (const key of keys) {
    const numericId = ['card_number', 'number', 'issue_number', 'taskId', 'task_id', 'id'].includes(key)
    const value = numericId ? scalar(input, key) : text(input, key)
    if (value !== null) return { text: numericId ? `#${value}` : value, mono: true }
  }
  if (tool.presentation?.paths?.length) return { text: tool.presentation.paths.join(' · '), mono: true }
  if (Array.isArray(input?.todos)) return { text: translate('tool.todo.count', { count: input.todos.length }), mono: false }
  return null
}


export type ToolQualifier = { text: string; hint: string }

/**
 * Call settings that explain an unusual cost or duration, shown as pills beside the summary.
 * Claude Code's Agent `effort` (2.1.292) runs the sub-agent at another level, so a `max` one is
 * slow and costly; Read's `allow_large` (2.1.296) lifts the usual size limit for one call. Both
 * stay in the raw arguments too; the pill only surfaces them on the collapsed line.
 */
export function toolQualifiers(tool: ToolItem): ToolQualifier[] {
  const input = fields(tool.input)
  if (tool.name === 'Agent' || tool.name === 'Task') {
    const effort = text(input, 'effort')?.trim()
    if (!effort) return []
    const key = EFFORT_KEYS[effort]
    const level = key ? translate(key) : effort
    return [{ text: translate('tool.qualifier.effort', { level }), hint: translate('tool.qualifier.effortHint', { level }) }]
  }
  if (tool.name === 'Read' && flag(input, 'allow_large')) {
    // With a range, the lifted limit applies to that range only: “whole file” would mislead.
    const ranged = scalar(input, 'offset') !== null || scalar(input, 'limit') !== null
    return [{ text: translate(ranged ? 'tool.qualifier.largeRange' : 'tool.qualifier.wholeFile'), hint: translate('tool.qualifier.allowLargeHint') }]
  }
  return []
}

/** Use the harness parser only when it describes the entire command unambiguously. */
function commandSummary(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 1) return null
  const action = fields(value[0])
  const path = text(action, 'path') ?? text(action, 'name')
  if (action?.type === 'read' && path) return translate('tool.summary.read', { path })
  if (action?.type === 'listFiles' && path) return translate('tool.summary.list', { path })
  const query = text(action, 'query')
  if (action?.type === 'search' && query) return translate(path ? 'tool.summary.searchIn' : 'tool.summary.search', { query, path: path ?? '' })
  return null
}
