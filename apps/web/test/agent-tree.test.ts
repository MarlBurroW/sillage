import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sillageEventSchema, type SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState, type ChatState } from '@sillage/protocol/chat-state'
import { buildAgentTree, type AgentNode } from '../src/lib/agent-tree'
import { buildBackground } from '../src/lib/background'
import { buildSubAgents } from '../src/lib/subagents'

/**
 * Frames shaped like those Claude Code 2.1.332 emitted when probed (card #22): a sub-agent that
 * starts a background shell and a nested sub-agent, and a background sub-agent resumed by
 * `SendMessage`.
 */
function fold(events: unknown[]): ChatState {
  return events.reduce<ChatState>((state, event, seq) => applyEvent(state, seq + 1, seq, sillageEventSchema.parse(event) as SillageEvent), emptyChatState())
}

function view(state: ChatState) {
  const agents = buildSubAgents(state.items, state.tasks)
  const background = buildBackground(state)
  return { agents, background, tree: buildAgentTree(agents, background) }
}

/** Compact shape of a tree: agent rows by description, background rows by task id. */
function shape(nodes: AgentNode[]): unknown[] {
  return nodes.map((node) => node.kind === 'agent'
    ? { agent: node.agent.description, children: shape(node.children) }
    : { work: node.work.id, children: shape(node.children) })
}

const spawn = (toolCallId: string, parent: string | null, description: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'tool.started', toolCallId, parentToolCallId: parent, name: 'Agent', input: { description, subagent_type: 'general-purpose', ...extra } })

test('a shell and a sub-agent launched by a sub-agent sit under it, not at the root', () => {
  const state = fold([
    spawn('call-outer', null, 'Outer'),
    { type: 'task.started', taskId: 'outer', toolCallId: 'call-outer', kind: 'local_agent', description: 'Outer', subagentType: 'general-purpose', runId: 'r1' },
    { type: 'tool.started', toolCallId: 'call-bash', parentToolCallId: 'call-outer', name: 'Bash', input: { command: 'sleep 6', run_in_background: true } },
    { type: 'background.updated', tasks: [{ id: 'shell', kind: 'local_bash', description: 'Background sleep', parentTaskId: 'outer', runId: 'r2' }] },
    { type: 'task.started', taskId: 'shell', toolCallId: 'call-bash', kind: 'local_bash', description: 'Background sleep', parentTaskId: 'outer', runId: 'r2' },
    { type: 'tool.completed', toolCallId: 'call-bash', output: 'Running in the background', isError: false, durationMs: 4 },
    spawn('call-inner', 'call-outer', 'Inner'),
    { type: 'task.started', taskId: 'inner', toolCallId: 'call-inner', kind: 'local_agent', description: 'Inner', parentTaskId: 'outer', subagentType: 'general-purpose', runId: 'r3' },
  ])
  const { tree } = view(state)
  assert.deepEqual(shape(tree.background), [])
  assert.deepEqual(shape(tree.agents), [
    { agent: 'Outer', children: [{ work: 'shell', children: [] }, { agent: 'Inner', children: [] }] },
  ])
  assert.equal(state.tasks.get('shell')?.parentTaskId, 'outer')
})

test('work whose parent is unknown or absent stays at the root', () => {
  const state = fold([
    { type: 'background.updated', tasks: [
      { id: 'orphan', kind: 'local_bash', description: 'Launched by a forgotten agent', parentTaskId: 'gone' },
      { id: 'main', kind: 'local_bash', description: 'Launched by the main thread' },
      // Ids come from the CLI: a loop must not make both rows vanish.
      { id: 'a', kind: 'local_agent', description: 'A', parentTaskId: 'b' },
      { id: 'b', kind: 'local_agent', description: 'B', parentTaskId: 'a' },
    ] },
  ])
  const { tree } = view(state)
  assert.deepEqual(shape(tree.background), [
    { work: 'orphan', children: [] },
    { work: 'main', children: [] },
    { work: 'b', children: [{ work: 'a', children: [] }] },
  ])
})

test('a resumed background sub-agent runs again in its own row, not as a second background entry', () => {
  const started = [
    spawn('call-spawn', null, 'Reply first', { run_in_background: true }),
    { type: 'background.updated', tasks: [{ id: 'agent', kind: 'local_agent', description: 'Reply first', subagentType: 'general-purpose', runId: 'run-1' }] },
    { type: 'task.started', taskId: 'agent', toolCallId: 'call-spawn', kind: 'local_agent', description: 'Reply first', subagentType: 'general-purpose', runId: 'run-1' },
    { type: 'tool.completed', toolCallId: 'call-spawn', output: 'Async agent launched', isError: false, durationMs: 30 },
    { type: 'message.completed', messageId: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'first' }], parentToolCallId: 'call-spawn' },
    { type: 'task.completed', taskId: 'agent', status: 'completed', summary: 'first', runId: 'run-1' },
    { type: 'background.updated', tasks: [] },
    // The CLI resumes it under the `SendMessage` call, with a new run of the same task.
    { type: 'tool.started', toolCallId: 'call-send', parentToolCallId: null, name: 'SendMessage', input: { to: 'agent', message: 'Now reply second' } },
    { type: 'background.updated', tasks: [{ id: 'agent', kind: 'local_agent', description: 'Reply first', subagentType: 'general-purpose', runId: 'run-2' }] },
    { type: 'task.started', taskId: 'agent', toolCallId: 'call-send', kind: 'local_agent', description: 'Reply first', subagentType: 'general-purpose', runId: 'run-2' },
    { type: 'tool.completed', toolCallId: 'call-send', output: 'Message sent', isError: false, durationMs: 5 },
  ]
  const resumed = view(fold(started))
  assert.equal(resumed.agents.length, 1)
  assert.equal(resumed.agents[0]?.status, 'running')
  assert.equal(resumed.agents[0]?.taskId, 'agent')
  assert.deepEqual(resumed.background, [])

  // A late frame of the first run changes nothing; the second run's end reports separately.
  const late = { type: 'task.progress', taskId: 'agent', activity: 'stale', toolUses: 1, totalTokens: 1, durationMs: 1, runId: 'run-1' }
  const lateEnd = { type: 'task.completed', taskId: 'agent', status: 'failed', summary: 'stale', runId: 'run-1' }
  assert.equal(fold([...started, late]).tasks.get('agent')?.activity, null)
  assert.equal(view(fold([...started, lateEnd])).agents[0]?.status, 'running')

  const ended = fold([...started, { type: 'task.completed', taskId: 'agent', status: 'completed', summary: 'second', runId: 'run-2' }])
  const reports = ended.items.filter((item) => item.kind === 'task')
  assert.deepEqual(reports.map((item) => [item.id, item.kind === 'task' && item.summary]), [['task-agent-run-1', 'first'], ['task-agent-run-2', 'second']])
})
