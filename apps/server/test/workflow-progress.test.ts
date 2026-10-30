import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEvent, emptyChatState, type ChatState } from '@sillage/protocol/chat-state'
import type { SillageEvent } from '@sillage/protocol'
import { parseWorkflowProgress } from '../src/agents/claude/workflow-progress.js'

/** Trimmed from a real Claude Code 2.1.312 `task_progress` of a three-agent workflow. */
const reported = [
  { type: 'workflow_phase', index: 1, title: 'Fondations' },
  { type: 'workflow_phase', index: 2, title: 'Moteur' },
  { type: 'workflow_phase', index: 3, title: 'Intégration' },
  {
    type: 'workflow_agent', index: 1, label: 'release', phaseIndex: 1, phaseTitle: 'Fondations',
    agentId: 'a2255afed4b4067a2', model: 'claude-opus-5-5', state: 'progress', startedAt: 1, queuedAt: 1,
    attempt: 1, lastToolName: 'Bash', lastToolSummary: 'cd collab/node_mod…', promptPreview: 'Projet…',
    tokens: 190850, toolCalls: 34,
  },
  {
    type: 'workflow_agent', index: 2, label: 'serveur', phaseIndex: 1, phaseTitle: 'Fondations',
    model: 'claude-opus-5-5', state: 'start', startedAt: 1, queuedAt: 1, tokens: 0, toolCalls: 0,
  },
  { type: 'workflow_agent', index: 3, label: 'interface', phaseIndex: 1, phaseTitle: 'Fondations', state: 'start', queuedAt: 1 },
]

test('workflow snapshot keeps phases and agents in script order', () => {
  const progress = parseWorkflowProgress(reported)
  assert.ok(progress)
  assert.deepEqual(progress.phases.map((phase) => phase.title), ['Fondations', 'Moteur', 'Intégration'])
  assert.deepEqual(
    progress.agents.map((agent) => [agent.label, agent.state]),
    // `start` with `startedAt` already runs; without it the agent waits for a slot.
    [['release', 'running'], ['serveur', 'running'], ['interface', 'queued']],
  )
  assert.equal(progress.agents[0]?.lastTool, 'Bash')
  assert.equal(progress.agents[0]?.lastToolSummary, 'cd collab/node_mod…')
  assert.equal(progress.agents[0]?.tokens, 190850)
})

test('unknown or missing workflow progress yields nothing instead of throwing', () => {
  assert.equal(parseWorkflowProgress(undefined), null)
  assert.equal(parseWorkflowProgress([]), null)
  assert.equal(parseWorkflowProgress('oops'), null)
  assert.equal(parseWorkflowProgress([{ type: 'workflow_agent', index: 1, label: 'x', state: 'teleporting' }, null, 3]), null)
})

test('failed agents carry their error and undeclared phases stay visible', () => {
  const progress = parseWorkflowProgress([
    { type: 'workflow_agent', index: 4, label: 'audit', phaseIndex: 9, phaseTitle: 'Revue', state: 'error', error: 'blocked by safety classifier' },
  ])
  assert.deepEqual(progress?.phases, [{ index: 9, title: 'Revue' }])
  assert.equal(progress?.agents[0]?.state, 'error')
  assert.equal(progress?.agents[0]?.error, 'blocked by safety classifier')
})

test('the fold keeps the last workflow snapshot across reports that omit it', () => {
  const workflow = parseWorkflowProgress(reported)
  const events: SillageEvent[] = [
    { type: 'task.started', taskId: 'w1', toolCallId: 'call-1', kind: 'local_workflow', description: 'Build', workflowName: 'build' },
    { type: 'task.progress', taskId: 'w1', activity: 'Fondations: release', lastTool: 'release', toolUses: 3, totalTokens: 10, durationMs: 5, workflow },
    { type: 'task.progress', taskId: 'w1', activity: 'Fondations: serveur', lastTool: 'serveur', toolUses: 4, totalTokens: 12, durationMs: 6, workflow: null },
  ]
  let state: ChatState = emptyChatState()
  events.forEach((event, index) => {
    state = applyEvent(state, index + 1, 0, event)
  })
  const task = state.tasks.get('w1')
  assert.equal(task?.workflowName, 'build')
  assert.equal(task?.toolUses, 4)
  assert.deepEqual(task?.workflow, workflow)
})
