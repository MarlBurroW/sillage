import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import type { WorkflowAgent, WorkflowProgress } from '@sillage/protocol'
import { api } from './api'
import type { TaskState, WorkflowAgentThreadPage } from './chat-fold'

/**
 * Workflow tasks by spawning tool call, for the `Workflow` card in the thread. A context rather than
 * a prop because rows are built from items alone; only workflow cards read it, so other calls do
 * not re-render on every progress report.
 */
export const WorkflowTasksContext = createContext<ReadonlyMap<string, TaskState>>(new Map())

export function useWorkflowTask(toolCallId: string): TaskState | null {
  return useContext(WorkflowTasksContext).get(toolCallId) ?? null
}

export function isWorkflowKind(kind: string): boolean {
  return kind.replace(/^local_/, '') === 'workflow'
}

/**
 * Workflow tasks keyed by their tool call; tasks the harness launched itself have none. With
 * `onlyEnded`, unfinished ones are left out: their process is gone, so their snapshot is stale.
 */
export function workflowTasksByToolCall(
  tasks: ReadonlyMap<string, TaskState>,
  onlyEnded = false,
): Map<string, TaskState> {
  const byToolCall = new Map<string, TaskState>()
  for (const task of tasks.values()) {
    if (!task.toolCallId || !isWorkflowKind(task.kind) || (onlyEnded && !task.done)) continue
    byToolCall.set(task.toolCallId, task)
  }
  return byToolCall
}

export interface WorkflowCounts {
  queued: number
  running: number
  done: number
  failed: number
}

export function workflowCounts(agents: readonly WorkflowAgent[]): WorkflowCounts {
  const counts: WorkflowCounts = { queued: 0, running: 0, done: 0, failed: 0 }
  for (const agent of agents) {
    if (agent.state === 'queued') counts.queued++
    else if (agent.state === 'running') counts.running++
    else if (agent.state === 'done') counts.done++
    else counts.failed++
  }
  return counts
}

export interface WorkflowPhaseGroup {
  /** Null groups agents launched outside any phase. */
  index: number | null
  title: string | null
  agents: WorkflowAgent[]
}

/**
 * Declared phases in script order with their agents, then agents outside any phase. Phases with no
 * agent yet stay listed: they show what remains, which a flat agent list cannot.
 */
export function workflowPhaseGroups(progress: WorkflowProgress): WorkflowPhaseGroup[] {
  const groups: WorkflowPhaseGroup[] = progress.phases.map((phase) => ({
    index: phase.index,
    title: phase.title,
    agents: progress.agents.filter((agent) => agent.phaseIndex === phase.index),
  }))
  const known = new Set(progress.phases.map((phase) => phase.index))
  const loose = progress.agents.filter((agent) => agent.phaseIndex === null || !known.has(agent.phaseIndex))
  if (loose.length > 0) groups.push({ index: null, title: null, agents: loose })
  return groups
}

/**
 * Phase the workflow is in: the first one with an unfinished agent, otherwise the last one that
 * started. Position counts from 1 over declared phases; null when the script declared none.
 */
export function currentPhase(
  progress: WorkflowProgress,
): { position: number; total: number; title: string } | null {
  const groups = progress.phases.map((phase) => ({
    phase,
    agents: progress.agents.filter((agent) => agent.phaseIndex === phase.index),
  }))
  if (groups.length === 0) return null
  let at = groups.findIndex((group) =>
    group.agents.some((agent) => agent.state === 'running' || agent.state === 'queued'),
  )
  if (at === -1) {
    at = groups.findLastIndex((group) => group.agents.length > 0)
    if (at === -1) at = 0
  }
  return { position: at + 1, total: groups.length, title: groups[at]?.phase.title ?? '' }
}

/** A workflow agent located in the workflows of the conversation, with the task that runs it. */
export interface LocatedWorkflowAgent {
  agent: WorkflowAgent
  task: TaskState
}

/** Latest snapshot entry for a CLI agent id; an agent retried keeps its id across attempts. */
export function findWorkflowAgent(workflows: Iterable<TaskState>, agentId: string): LocatedWorkflowAgent | null {
  for (const task of workflows) {
    const agent = task.workflow?.agents.find((candidate) => candidate.agentId === agentId)
    if (agent) return { agent, task }
  }
  return null
}

/** Polling cadence while the agent runs: the CLI appends to its transcript every second or two. */
const WORKFLOW_THREAD_POLL_MS = 2500

type LoadedThread = Extract<WorkflowAgentThreadPage, { unchanged: false }>

/**
 * End of a workflow agent's thread, read from its transcript by the server. Polled while the agent
 * runs; each request sends the version it holds, so a thread that has not moved costs a few bytes.
 */
export function useWorkflowAgentThread(conversationId: string, agentId: string, running: boolean, limit: number) {
  const client = useQueryClient()
  const key = ['workflow-agent-thread', conversationId, agentId, limit]
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<LoadedThread> => {
      const held = client.getQueryData<LoadedThread>(key)
      const query = new URLSearchParams({ limit: String(limit) })
      if (held) query.set('version', String(held.version))
      const page = await api.get<WorkflowAgentThreadPage>(
        `/api/conversations/${conversationId}/workflow-agents/${encodeURIComponent(agentId)}/thread?${query}`,
        signal,
      )
      return page.unchanged && held ? held : page.unchanged ? { unchanged: false, items: null, earlier: 0, version: page.version } : page
    },
    refetchInterval: running ? WORKFLOW_THREAD_POLL_MS : false,
    placeholderData: (previous) => previous,
  })
}
