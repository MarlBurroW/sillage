import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState } from '../src/lib/chat-fold'
import { buildSubAgents, subAgentSubtitle } from '../src/lib/subagents'

function fold(events: SillageEvent[]) {
  return events.reduce((state, event, index) => applyEvent(state, index + 1, index + 1, event), emptyChatState())
}

test('a sub-agent row names the model and effort its call carries, including ones learned later', () => {
  const state = fold([
    { type: 'tool.started', toolCallId: 'relay', name: 'Agent', input: { description: '/root/relay', prompt: 'Relay' }, parentToolCallId: null },
    // Codex names the model once the spawning call is seen: the runner updates the call's input.
    { type: 'tool.input_updated', toolCallId: 'relay', input: { description: '/root/relay', prompt: 'Relay', model: 'gpt-6.1-terra', effort: 'medium' } },
    { type: 'tool.started', toolCallId: 'pong', name: 'Agent', input: { description: '/root/relay/pong', prompt: 'Pong' }, parentToolCallId: 'relay' },
  ])
  const [relay, pong] = buildSubAgents(state.items, state.tasks)
  assert.equal(relay?.model, 'gpt-6.1-terra')
  assert.equal(relay?.effort, 'medium')
  assert.equal(subAgentSubtitle(relay!, 'Reading'), 'Agent · gpt-6.1-terra · Effort: Medium · Reading')
  // Nothing named: the line stays what it was, with no empty separators.
  assert.equal(pong?.parentId, 'relay')
  assert.equal(subAgentSubtitle(pong!, null), 'Agent')
})

test("Claude's Agent overrides read the same way, unknown levels shown as given", () => {
  const state = fold([
    { type: 'tool.started', toolCallId: 'explore', name: 'Agent', parentToolCallId: null,
      input: { description: 'Find callers', prompt: '…', subagent_type: 'Explore', model: 'haiku', effort: 'ultra' } },
  ])
  const [explore] = buildSubAgents(state.items, state.tasks)
  assert.equal(subAgentSubtitle(explore!, null), 'Explore · haiku · Effort: ultra')
})
