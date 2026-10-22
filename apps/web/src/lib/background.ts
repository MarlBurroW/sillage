import { isSpawnTool } from '@sillage/protocol'
import type { ChatState } from './chat-fold'

/**
 * Work with no other screen representation, derived solely from the log (invariant I2). The CLI
 * lists all living work together, including already-visible subagents and otherwise unknown
 * workflows. Subagents already have a banner, row, and thread whether backgrounded or not;
 * repeating them would obscure the only cases this view needs: workflows, background commands, and
 * watchers with nowhere else to appear.
 */

export interface BackgroundWork {
  id: string
  kind: string
  description: string
  /** Current activity, null until its first report. */
  activity: string | null
  lastTool: string | null
  toolUses: number
  totalTokens: number
}

export function buildBackground(state: ChatState): BackgroundWork[] {
  const works: BackgroundWork[] = []
  const spawned = new Set(
    state.items
      .filter((item) => item.kind === 'tool' && isSpawnTool(item.name))
      .map((item) => item.id),
  )

  for (const live of state.background) {
    const task = state.tasks.get(live.id)
    // A task whose launch is absent from the folded thread cannot be associated with anything: show
    // it rather than hide it because the snapshot confirms it is running. This happens after REST
    // reload when socket lag is too large.
    if (task?.toolCallId && spawned.has(task.toolCallId)) continue

    works.push({
      id: live.id,
      kind: live.kind,
      description: task?.description || live.description,
      activity: task?.activity ?? null,
      lastTool: task?.lastTool ?? null,
      toolUses: task?.toolUses ?? 0,
      totalTokens: task?.totalTokens ?? 0,
    })
  }

  return works
}
