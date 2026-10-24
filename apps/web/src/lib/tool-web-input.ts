import { codexWebSearchInput } from '@sillage/protocol'
import type { ToolItem } from './chat-fold'
import { fields } from './tool-payload'

/** Recover final arguments from older Codex journals, without fetching collapsed tool bodies. */
export function toolWebInput(tool: Pick<ToolItem, 'name' | 'input' | 'output' | 'status'>): unknown {
  if ((tool.name !== 'WebSearch' && tool.name !== 'WebFetch') || tool.status === 'running') return tool.input
  const output = fields(tool.output)
  if (!output || typeof output.query !== 'string' || !('action' in output) || !('results' in output)) return tool.input
  const action = fields(output.action)
  if (!action && !output.query.trim()) return tool.input
  if (output.action !== null && (!action || !['search', 'openPage', 'findInPage', 'other'].includes(String(action.type)))) return tool.input
  return { ...fields(tool.input), ...codexWebSearchInput(output.query, action) }
}
