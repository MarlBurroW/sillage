import { isSpawnTool } from '@sillage/protocol'
import { hasVisibleContent, type ChatItem, type ToolItem } from './chat-fold'
import { isSillageTool } from './sillage-tools'

/**
 * Prepare a thread for rendering. First, a thread shows only its author's output. Subagent messages
 * and calls carry the spawning call ID and belong in the panel: mixing them with main-agent replies
 * obscures authorship and makes parallel subagents indistinguishable. Keep only the spawning call
 * in the main thread; use this same module to split panel threads. Second, collapse consecutive
 * completed calls into one row because individual rows add little and push the answer away. Running
 * calls keep their own row because users may need to watch them.
 */

export type ChatRow =
  | { kind: 'item'; key: string; item: ChatItem }
  | { kind: 'tool'; key: string; tool: ToolItem }
  | { kind: 'tool-group'; key: string; tools: ToolItem[] }

/** Below this threshold, collapsing costs a click without saving a row. */
const MIN_GROUP_SIZE = 2

/**
 * Split a thread into displayable rows. `thread` identifies its author: `null` for the main agent,
 * spawning call ID for a subagent. Items other than messages and tool calls (permissions, plans,
 * questions, errors, notices) have no author and stay in the main thread: the only place to answer
 * prompts or make sense of session errors.
 */
export function buildRows(items: ChatItem[], thread: string | null = null): ChatRow[] {
  const rows: ChatRow[] = []
  let run: ToolItem[] = []

  /**
   * Flush the current sequence. Group completed calls while keeping running ones separate and
   * preserving chronological order: calls can run in parallel and the active one need not be last.
   * Keep the group when another call starts afterward. Previously it dissolved, expanding then
   * collapsing the entire sequence and resetting manually opened groups because their component
   * unmounted.
   */
  const flush = () => {
    if (run.length === 0) return

    let done: ToolItem[] = []
    const flushDone = () => {
      const first = done[0]
      if (first && done.length >= MIN_GROUP_SIZE) {
        rows.push({ kind: 'tool-group', key: `tools-${first.id}`, tools: done })
      } else {
        for (const tool of done) rows.push({ kind: 'tool', key: tool.id, tool })
      }
      done = []
    }

    for (const tool of run) {
      if (tool.status === 'running') {
        flushDone()
        rows.push({ kind: 'tool', key: tool.id, tool })
      } else {
        done.push(tool)
      }
    }
    flushDone()

    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool') {
      if (item.parentToolCallId !== thread) continue

      // Subagent launches retain a row: the only sign that a whole part of the work happened
      // elsewhere, indistinguishable from a `Read` if buried in a five-tool group. Likewise,
      // scheduled tasks containing a check script retain their row because it carries requested
      // approval that collapsing would hide.
      if (isSpawnTool(item.name) || proposesCheck(item)) {
        flush()
        rows.push({ kind: 'tool', key: item.id, tool: item })
      } else {
        run.push(item)
      }
      continue
    }

    if (item.kind === 'message') {
      if (item.parentToolCallId !== thread) continue
    } else if (thread !== null) {
      continue
    }

    // An invisible item must not interrupt a tool sequence.
    if (!hasVisibleContent(item)) continue

    flush()
    rows.push({ kind: 'item', key: item.id, item })
  }
  flush()

  return rows
}

function proposesCheck(tool: ToolItem): boolean {
  if (!isSillageTool(tool.name, 'schedule_task')) return false
  const input = tool.input as { check_script?: unknown } | null
  return typeof input?.check_script === 'string' && input.check_script.trim() !== ''
}
