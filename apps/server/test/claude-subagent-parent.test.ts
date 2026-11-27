import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { DEFAULT_CLAUDE_CONFIG, type SillageEvent } from '@sillage/protocol'
import { ClaudeRunner } from '../src/agents/claude/runner.js'
import type { RunnerContext } from '../src/agents/types.js'

/**
 * Who launched what, as Claude Code 2.1.332 (SDK 0.3.332) reports it: frames copied from a probe
 * of the installed binary, trimmed to the fields Sillage reads (card #22).
 */
function runner() {
  const events: SillageEvent[] = []
  const ctx: RunnerContext = {
    conversationId: 'test', cwd: tmpdir(), config: DEFAULT_CLAUDE_CONFIG, resumeSessionId: null, attachmentsRoot: tmpdir(), binary: 'unused',
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
    emit: (event) => events.push(event), setStatus: () => {}, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => 'permission', closePermissionRequest: () => {},
  }
  const instance = new ClaudeRunner(ctx)
  const translate = (message: Record<string, unknown>) =>
    (instance as unknown as { translate(message: unknown): void }).translate({ uuid: 'u', session_id: 's', ...message })
  return { instance, events, translate }
}

const outerStarted = {
  type: 'system', subtype: 'task_started', task_id: 'a0d96b2c42487da71', run_id: '0mwzc66b3-e8e10f48',
  tool_use_id: 'toolu_outer', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Outer', spawn_depth: 1,
}

test('background work and task starts carry their launcher, agent type and run', () => {
  const f = runner()
  f.translate(outerStarted)
  f.translate({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'brxobm9xs', run_id: '0mwzc67au-b88cea8e', task_type: 'local_bash', description: 'Run background sleep', parent_task_id: 'a0d96b2c42487da71' }],
  })
  f.translate({
    type: 'system', subtype: 'task_started', task_id: 'ac4a60bb5f468218a', run_id: '0mwzc67ot-b6ea6f91', tool_use_id: 'toolu_inner',
    task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Inner', spawn_depth: 2, parent_task_id: 'a0d96b2c42487da71',
  })
  f.translate({ type: 'system', subtype: 'task_progress', task_id: 'ac4a60bb5f468218a', run_id: '0mwzc67ot-b6ea6f91', description: 'Reading', usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 } })
  f.translate({ type: 'system', subtype: 'task_notification', task_id: 'ac4a60bb5f468218a', run_id: '0mwzc67ot-b6ea6f91', status: 'completed', output_file: '', summary: 'ok' })

  const background = f.events.find((event) => event.type === 'background.updated' && event.tasks.length > 0)
  assert.ok(background?.type === 'background.updated')
  assert.deepEqual(background.tasks[0], {
    id: 'brxobm9xs', kind: 'local_bash', description: 'Run background sleep',
    parentTaskId: 'a0d96b2c42487da71', subagentType: undefined, runId: '0mwzc67au-b88cea8e',
  })
  const started = f.events.filter((event) => event.type === 'task.started')
  assert.deepEqual(started.map((event) => event.type === 'task.started' && [event.parentTaskId, event.subagentType, event.runId]), [
    [undefined, 'general-purpose', '0mwzc66b3-e8e10f48'],
    ['a0d96b2c42487da71', 'general-purpose', '0mwzc67ot-b6ea6f91'],
  ])
  const ends = f.events.filter((event) => event.type === 'task.progress' || event.type === 'task.completed')
  assert.deepEqual(ends.map((event) => 'runId' in event && event.runId), ['0mwzc67ot-b6ea6f91', '0mwzc67ot-b6ea6f91'])
})

test('a sub-agent message naming only its agent_id lands in that sub-agent thread', () => {
  const f = runner()
  f.translate(outerStarted)
  // A resume is launched by `SendMessage`: it must not move the thread to that call.
  f.translate({ ...outerStarted, run_id: '0mwzc77k6-d01f756e', tool_use_id: 'toolu_send' })
  f.translate({
    type: 'assistant', parent_tool_use_id: null, agent_id: 'a0d96b2c42487da71',
    message: { id: 'msg_1', content: [{ type: 'text', text: 'second' }, { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }] },
  })
  const completed = f.events.find((event) => event.type === 'message.completed')
  assert.ok(completed?.type === 'message.completed')
  assert.equal(completed.parentToolCallId, 'toolu_outer')
  const tool = f.events.find((event) => event.type === 'tool.started')
  assert.ok(tool?.type === 'tool.started')
  assert.equal(tool.parentToolCallId, 'toolu_outer')
  // A sub-agent speaking opens no main turn.
  assert.equal(f.events.filter((event) => event.type === 'turn.started').length, 0)
  // The main thread still opens one.
  f.translate({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_2', content: [{ type: 'text', text: 'main' }] } })
  assert.equal(f.events.filter((event) => event.type === 'turn.started').length, 1)
})
