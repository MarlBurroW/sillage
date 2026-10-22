import { isSpawnTool } from '@sillage/protocol'
import { activityOf, type ChatItem, type ChatState, type TaskState, type ToolItem } from './chat-fold'

/**
 * Conversation subagents derived solely from the log (invariant I2). A subagent has no independent
 * server entity: it is a tool call, and all output carries that call ID. Use it as identity here,
 * with no parallel state or requests.
 */

export interface SubAgent {
  /** Spawning call. Serves as identity and association key. */
  id: string
  /** Type declared at invocation (`Explore`, `general-purpose`, etc.), falling back to the tool name. */
  type: string
  /** What the call says it is seeking. Empty if omitted by the CLI. */
  description: string
  status: ToolItem['status']
  startedAt: number
  /** Known only after call completion: the CLI does not provide it earlier. */
  durationMs: number | null
  /** Current activity, or null when no longer running. */
  activity: string | null
  /** Subagent thread in log order. */
  items: ChatItem[]
  /** Its own tool calls. Nested subagent calls count toward that nested agent. */
  toolCount: number
  /**
   * Usage reported by the CLI. Zero until a report arrives: the thread cannot infer subagent tokens
   * because they appear nowhere else.
   */
  totalTokens: number
  /** Parent subagent's spawning call for nesting. */
  parentId: string | null
}

function field(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return ''
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/**
 * One subagent per spawning call, in launch order. Keep calls whose log has no child output yet:
 * several seconds can pass before the first event, and omitting them would make the banner appear
 * then flicker.
 */
export function buildSubAgents(items: ChatItem[], tasks: ChatState['tasks']): SubAgent[] {
  const byId = new Map<string, SubAgent>()
  // The CLI identifies tasks by their own IDs; the thread knows only the tool call, which links the two views.
  const byToolCall = new Map<string, TaskState>()
  for (const task of tasks.values()) {
    if (task.toolCallId) byToolCall.set(task.toolCallId, task)
  }

  for (const item of items) {
    if (item.kind !== 'tool' || !isSpawnTool(item.name)) continue
    const task = byToolCall.get(item.id)
    /*
     * A backgrounded agent immediately returns its tool call with a result saying it continues
     * elsewhere. Without correction the row claimed completion in forty milliseconds while work
     * continued for twenty seconds, and the banner stopped counting it as active.
     */
    const backgrounded = task !== undefined && !task.done && item.status === 'done'
    /*
     * Conversely, an agent stopped with its session has returned its call without completing its
     * work. Without correction the row labeled an agent completed even though it was never heard
     * from again.
     */
    const cutShort = task?.outcome === 'stopped' && item.status === 'done'
    byId.set(item.id, {
      id: item.id,
      type: field(item.input, 'subagent_type') || item.name,
      description: field(item.input, 'description'),
      status: backgrounded ? 'running' : cutShort ? 'interrupted' : item.status,
      startedAt: item.ts,
      // Call duration equals task duration only while the call is waiting for it.
      durationMs: task && task.durationMs > 0 ? task.durationMs : item.durationMs,
      activity: null,
      items: [],
      toolCount: 0,
      totalTokens: task?.totalTokens ?? 0,
      parentId: item.parentToolCallId,
    })
  }

  if (byId.size === 0) return []

  for (const item of items) {
    if (item.kind !== 'message' && item.kind !== 'tool') continue
    const parent = item.parentToolCallId ? byId.get(item.parentToolCallId) : undefined
    if (!parent) continue

    parent.items.push(item)
    if (item.kind === 'tool') parent.toolCount += 1
  }

  const agents = [...byId.values()]
  for (const agent of agents) {
    if (agent.status !== 'running') continue
    // The CLI describes its agent's activity, including reasoning without tool calls. Log fallback
    // covers the seconds before the first report and CLIs that never report.
    agent.activity = byToolCall.get(agent.id)?.activity ?? activityOf(agent.items, agent.id)
  }
  return agents
}

/** Shortest meaningful subagent label for a list. */
export function subAgentLabel(agent: SubAgent): string {
  return agent.description || agent.type
}
