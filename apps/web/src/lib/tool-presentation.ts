import type { ToolItem } from './chat-fold'
import { translate, type MessageKey } from './i18n'

export type ToolOrigin = { kind: 'native' | 'sillage' | 'mcp'; server: string; name: string }

/** Les adaptateurs normalisent OpenCode en serveur/outil ; les anciens journaux restent lisibles. */
export function toolOrigin(name: string): ToolOrigin {
  const claude = /^mcp__([^]+?)__(.+)$/.exec(name)
  const slash = /^([^/]+)\/(.+)$/.exec(name)
  const legacy = name.startsWith('sillage_') ? ['','sillage',name.slice(8)] : null
  const match = claude ?? slash ?? legacy
  return match ? { kind: match[1] === 'sillage' ? 'sillage' : 'mcp', server: match[1]!, name: match[2]! }
    : { kind: 'native', server: '', name }
}
const SILLAGE_LABELS: Record<string, MessageKey> = {
  search_history: 'sillageTool.search_history',
  read_conversation: 'sillageTool.read_conversation',
  list_sessions: 'sillageTool.list_sessions',
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

export function toolLabel(name: string): string {
  const origin = toolOrigin(name)
  const key = origin.kind === 'sillage' ? SILLAGE_LABELS[origin.name] : undefined
  if (key) return translate(key)
  // Aucun sens inventé pour un serveur inconnu : on enlève seulement le préfixe et les séparateurs.
  return origin.kind === 'native' ? name : origin.name.replace(/[_-]+/g, ' ')
}
export type ToolIntent = 'context' | 'inspect' | 'change' | 'verify' | 'other'
export const INTENT_LABELS: Record<ToolIntent, MessageKey> = {
  context: 'toolStyle.context', inspect: 'toolStyle.inspect', change: 'toolStyle.change', verify: 'toolStyle.verify', other: 'toolStyle.other',
}
export function toolIntent(tool: ToolItem): ToolIntent {
  const origin = toolOrigin(tool.name)
  if (origin.kind === 'sillage') {
    if (/^(read|list|search|find|count)_/.test(origin.name)) return 'context'
    return 'change'
  }
  if (['Read','Glob','Grep','WebFetch','WebSearch','ViewImage'].includes(tool.name)) return 'inspect'
  if (['Edit','Write','ApplyPatch'].includes(tool.name)) return 'change'
  // Une commande arbitraire n’est pas une vérification.
  if (tool.name === 'Bash' && /(?:^|[\s:])(?:test|typecheck|lint|check)(?:$|[\s:])/.test(String((tool.input as { command?: unknown } | null)?.command ?? ''))) return 'verify'
  return 'other'
}

/** Aperçu borné, sans charger les sorties complètes ni sérialiser des objets volumineux. */
export function toolPreview(tool: ToolItem): string {
  if (tool.status === 'running') return translate('toolStyle.outputPending')
  let output = tool.output
  if (Array.isArray(output)) output = output.find((part) => part?.type === 'text')?.text
  if (typeof output === 'string' && output.slice(0,500).trim()) return output.slice(0,500).replace(/\s+/g,' ').trim()
  return translate('toolStyle.outputEmpty')
}
