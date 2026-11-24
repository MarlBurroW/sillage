import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sillageEventSchema, type SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState, threadOf, type ChatState } from '@sillage/protocol/chat-state'

/** Reports of unattended work land in the thread of the agent that launched it; model status lines follow the task. */

function fold(events: unknown[]): ChatState {
  return events.reduce<ChatState>((state, event, seq) => applyEvent(state, seq + 1, seq, sillageEventSchema.parse(event) as SillageEvent), emptyChatState())
}

function backgroundBash(parent: string | null, id: string): unknown[] {
  return [
    { type: 'tool.started', parentToolCallId: parent, toolCallId: `call-${id}`, name: 'Bash', input: { command: 'pnpm test', run_in_background: true } },
    { type: 'task.started', taskId: id, toolCallId: `call-${id}`, kind: 'local_bash', description: `Tests ${id}` },
    { type: 'tool.completed', toolCallId: `call-${id}`, output: 'Running in the background', isError: false, durationMs: 5 },
    { type: 'background.updated', tasks: [{ id, kind: 'local_bash', description: `Tests ${id}` }] },
    { type: 'task.completed', taskId: id, status: 'completed', summary: `Tests ${id} passed` },
  ]
}

test('a background command started by a subagent reports in that subagent thread', () => {
  const state = fold([
    { type: 'tool.started', parentToolCallId: null, toolCallId: 'agent', name: 'Agent', input: { description: 'Librarian' } },
    ...backgroundBash('agent', 'sub'),
    ...backgroundBash(null, 'main'),
  ])
  const reports = state.items.filter((item) => item.kind === 'task')
  assert.deepEqual(reports.map((item) => [item.id, threadOf(item)]), [['task-sub', 'agent'], ['task-main', null]])
})

test('a subagent keeps its latest model status until it ends', () => {
  const progress = (summary: string | null) => ({ type: 'task.progress', taskId: 'agent-task', activity: 'Reading a file', toolUses: 1, totalTokens: 10, durationMs: 10, summary })
  const started = [
    { type: 'tool.started', parentToolCallId: null, toolCallId: 'agent', name: 'Agent', input: { description: 'Librarian' } },
    { type: 'task.started', taskId: 'agent-task', toolCallId: 'agent', kind: 'local_agent', description: 'Librarian' },
  ]
  // Most reports carry no summary: the last one written stays current.
  assert.equal(fold([...started, progress('Wiring the feedback page'), progress(null)]).tasks.get('agent-task')?.summary, 'Wiring the feedback page')
  const ended = fold([...started, progress('Wiring the feedback page'), { type: 'task.completed', taskId: 'agent-task', status: 'completed', summary: 'Done' }])
  assert.equal(ended.tasks.get('agent-task')?.summary, null)
})
