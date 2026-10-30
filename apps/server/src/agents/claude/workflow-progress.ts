import type { WorkflowAgent, WorkflowAgentState, WorkflowProgress } from '@sillage/protocol'

/**
 * Reads the `workflow_progress` array Claude Code attaches to a workflow's `task_progress`
 * (probed on 2.1.312). The field is absent from the SDK types, so nothing here may throw: an entry
 * of an unknown shape is skipped, and an array yielding nothing returns null, which leaves the
 * panel on the last snapshot rather than blanking it.
 */
export function parseWorkflowProgress(raw: unknown): WorkflowProgress | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const phases = new Map<number, { index: number; title: string }>()
  const agents = new Map<number, WorkflowAgent>()

  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.index !== 'number') continue
    if (entry.type === 'workflow_phase' && typeof entry.title === 'string') {
      phases.set(entry.index, { index: entry.index, title: entry.title })
    } else if (entry.type === 'workflow_agent' && typeof entry.label === 'string') {
      const state = agentState(entry)
      if (!state) continue
      const phaseIndex = num(entry.phaseIndex)
      // Agents may name a phase the script never declared in `meta.phases`: keep it visible.
      if (phaseIndex !== null && !phases.has(phaseIndex) && typeof entry.phaseTitle === 'string') {
        phases.set(phaseIndex, { index: phaseIndex, title: entry.phaseTitle })
      }
      // The CLI merges updates by index; a repeated index in one report is the later state.
      agents.set(entry.index, {
        index: entry.index,
        label: entry.label,
        phaseIndex,
        state,
        model: str(entry.model),
        lastTool: str(entry.lastToolName),
        lastToolSummary: str(entry.lastToolSummary),
        tokens: num(entry.tokens) ?? 0,
        toolCalls: num(entry.toolCalls) ?? 0,
        attempt: num(entry.attempt) ?? 1,
        error: str(entry.error),
      })
    }
  }

  if (phases.size === 0 && agents.size === 0) return null
  return {
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
  }
}

/** Mirrors how the CLI itself counts running agents: a `start` without `startedAt` still waits. */
function agentState(entry: Record<string, unknown>): WorkflowAgentState | null {
  switch (entry.state) {
    case 'start':
      return entry.startedAt === undefined && entry.queuedAt !== undefined ? 'queued' : 'running'
    case 'progress':
      return 'running'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    default:
      return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
