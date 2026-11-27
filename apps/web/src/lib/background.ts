import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { isSpawnTool } from '@sillage/protocol'
import type { BackgroundTaskOutput, WorkflowProgress } from '@sillage/protocol'
import { api } from './api'
import type { ChatState } from './chat-fold'
import { stopBackgroundTask } from './conversations'

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
  /** Status line the model wrote about it, when the CLI sends one. */
  summary: string | null
  lastTool: string | null
  toolUses: number
  totalTokens: number
  /** Script name and phase/agent snapshot, null for other work and until the first report. */
  workflowName: string | null
  workflow: WorkflowProgress | null
  /** Task that launched it (a sub-agent), null for the main thread or when the CLI does not say. */
  parentTaskId: string | null
  /** Agent type of a backgrounded sub-agent (`general-purpose`, a custom agent), null otherwise. */
  subagentType: string | null
  /** Stoppable although the CLI cannot stop background work in general (a Codex goal, which pauses). */
  stoppable: boolean
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
      summary: task?.summary ?? null,
      lastTool: task?.lastTool ?? null,
      toolUses: task?.toolUses ?? 0,
      totalTokens: task?.totalTokens ?? 0,
      workflowName: task?.workflowName ?? null,
      workflow: task?.workflow ?? null,
      parentTaskId: live.parentTaskId ?? task?.parentTaskId ?? null,
      subagentType: live.subagentType ?? task?.subagentType ?? null,
      stoppable: live.stoppable === true,
    })
  }

  return works
}

/** Shell tasks (Bash `run_in_background` and Monitor both report `local_bash`) are the only ones the CLI keeps output for. */
export function hasReadableOutput(kind: string): boolean {
  const family = kind.replace(/^local_/, '')
  return family === 'bash' || family === 'shell'
}

/**
 * Polls a background shell's tail while its row is open. The CLI streams nothing: each read is a
 * cheap control request with no model turn, so a short interval is fine, and closing the row stops it.
 */
export function useBackgroundTaskOutput(conversationId: string, taskId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['background-output', conversationId, taskId],
    queryFn: ({ signal }) =>
      api.get<BackgroundTaskOutput>(
        `/api/conversations/${conversationId}/background/${encodeURIComponent(taskId)}/output`,
        signal,
      ),
    enabled,
    refetchInterval: enabled ? 1500 : false,
    // A 404 means the session or the task is gone: retrying only delays saying so.
    retry: false,
  })
}

/**
 * Output as text: the CLI hands back raw terminal bytes. Drops CSI/OSC sequences and other escapes,
 * and resolves carriage-return redraws (progress bars) to the last state of each line.
 */
export function plainTerminalText(raw: string): string {
  const stripped = raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
  return stripped
    .split('\n')
    .map((line) => {
      // CRLF endings first, so only redraws remain; with none, lastIndexOf's -1 keeps the whole line.
      const trimmed = line.replace(/\r+$/, '')
      return trimmed.slice(trimmed.lastIndexOf('\r') + 1)
    })
    .join('\n')
}

/**
 * Stops background work from any list that shows it. Stop replies do not confirm termination: the
 * task leaves on the next `background.updated`, so the button stays pending meanwhile rather than
 * inviting repeated requests. A rejection (session ended, task already closed) makes it usable again.
 */
export function useStopBackgroundTask(conversationId: string) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const stop = async (taskId: string) => {
    setStopping((prev) => new Set(prev).add(taskId))
    try {
      await stopBackgroundTask(conversationId, taskId)
    } catch {
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }
  return { stopping, stop }
}
