import type { ReactNode } from 'react'
import type { ToolItem } from '../../lib/chat-fold'
import { VIEWS, genericView } from './views'

/**
 * Tool renderer registry with three fallback levels: dedicated views, generic payload formatting,
 * and raw database JSON shown by ToolCall on failure or request. Views decide at runtime, not just
 * by registered names: Edit payload fields may differ across CLI versions. Unknown shapes return
 * null instead of guessing.
 */
export function readableView(tool: ToolItem): ReactNode {
  const view = VIEWS[tool.name]
  return view?.(tool) ?? genericView(tool)
}
