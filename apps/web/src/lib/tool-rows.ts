import { isSpawnTool } from '@sillage/protocol'
import { hasVisibleContent, type ChatItem, type ToolItem } from './chat-fold'
import { isSillageTool } from './sillage-tools'

/** Les suites restent distinctes des autres événements ; leur repli relève de la lecture du fil. */

export type ChatRow =
  | { kind: 'item'; key: string; item: ChatItem }
  | { kind: 'tool'; key: string; tool: ToolItem }
  | { kind: 'tool-group'; key: string; tools: ToolItem[]; complete: boolean }

/**
 * Split a thread into displayable rows. `thread` identifies its author: `null` for the main agent,
 * spawning call ID for a subagent. Items other than messages and tool calls (permissions, plans,
 * questions, errors, notices) have no author and stay in the main thread: the only place to answer
 * prompts or make sense of session errors.
 */
export function buildRows(items: ChatItem[], thread: string | null = null, turnRunning = false): ChatRow[] {
  const rows: ChatRow[] = []
  let run: ToolItem[] = []

  // La même clé existe dès le premier appel : terminer la série ne remonte pas ses enfants.
  const flush = (boundary = false) => {
    const first = run[0]
    if (!first) return
    rows.push({ kind: 'tool-group', key: `tools-${first.id}`, tools: run,
      complete: boundary && run.every((tool) => tool.status !== 'running') })
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

    const textResumed = item.kind === 'message' && (item.streamingText.trim().length > 0 || item.blocks.some((block) => block.type === 'text' && block.text.trim().length > 0))
    flush(textResumed)
    rows.push({ kind: 'item', key: item.id, item })
  }
  flush(!turnRunning)

  // Une pensée ou une notice peut séparer les appels du texte qui clôt leur série.
  let textAfter = !turnRunning
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.kind === 'item' && row.item.kind === 'message' && (row.item.streamingText.trim() || row.item.blocks.some((block) => block.type === 'text' && block.text.trim()))) textAfter = true
    if (row.kind === 'tool-group' && textAfter && row.tools.every((tool) => tool.status !== 'running')) row.complete = true
  }
  return rows
}

function proposesCheck(tool: ToolItem): boolean {
  if (!isSillageTool(tool.name, 'schedule_task')) return false
  const input = tool.input as { check_script?: unknown } | null
  return typeof input?.check_script === 'string' && input.check_script.trim() !== ''
}
