import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JournalEntry, SillageEvent } from '@sillage/protocol'
import { computeRunMetrics } from '../src/benchmarks/metrics.js'

/** Journal entries at the given millisecond offsets, in order. */
function journal(steps: [number, SillageEvent][]): JournalEntry[] {
  return steps.map(([ts, event], index) => ({ conversationId: 'c', seq: index + 1, ts: 1_000_000 + ts, event }))
}

test('benchmark metrics: durations run from the user message, tokens add up across turns', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'session.started', agent: 'claude', agentSessionId: 's', model: 'claude-sonnet-5-5', cwd: '/tmp', tools: [] }],
    // Startup time before the user message is Sillage's, not the model's.
    [1500, { type: 'message.started', messageId: 'u1', role: 'user' }],
    [1500, { type: 'message.completed', messageId: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hello' }], parentToolCallId: null }],
    [1600, { type: 'turn.started' }],
    [2300, { type: 'message.started', messageId: 'a1', role: 'assistant' }],
    [2300, { type: 'message.delta', messageId: 'a1', text: 'Let me', parentToolCallId: null }],
    [2400, { type: 'tool.started', toolCallId: 't1', name: 'Read', input: {}, parentToolCallId: null }],
    [2900, { type: 'tool.completed', toolCallId: 't1', output: 'x', isError: false, durationMs: 500 }],
    [3000, { type: 'tool.started', toolCallId: 't2', name: 'Bash', input: {}, parentToolCallId: null }],
    [3200, { type: 'tool.completed', toolCallId: 't2', output: 'boom', isError: true, durationMs: 200 }],
    [3300, { type: 'tool.started', toolCallId: 't3', name: 'Read', input: {}, parentToolCallId: 't2' }],
    [3400, { type: 'tool.completed', toolCallId: 't3', output: 'y', isError: false, durationMs: 100 }],
    [4000, { type: 'message.completed', messageId: 'a1', role: 'assistant', blocks: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Let me look.' }], parentToolCallId: null }],
    [4100, { type: 'message.completed', messageId: 'a2', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }], parentToolCallId: null }],
    [4200, { type: 'usage.updated', costUsd: 0.01, inputTokens: 10, outputTokens: 20, context: { usedTokens: 1234, maxTokens: 200000, ratio: 0.006 } }],
    [4500, { type: 'turn.completed', stopReason: 'end_turn', costUsd: 0.01, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 300 }],
    [9000, { type: 'message.started', messageId: 'u2', role: 'user' }],
    [9500, { type: 'turn.completed', stopReason: 'end_turn', costUsd: 0.02, inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 400 }],
  ]))

  assert.equal(metrics.durationMs, 8000)
  assert.equal(metrics.firstTextMs, 800)
  assert.equal(metrics.inputTokens, 11)
  assert.equal(metrics.outputTokens, 22)
  assert.equal(metrics.cacheCreationTokens, 5)
  assert.equal(metrics.cacheReadTokens, 700)
  assert.ok(Math.abs((metrics.costUsd ?? 0) - 0.03) < 1e-9)
  assert.equal(metrics.toolCalls, 3)
  assert.deepEqual(metrics.toolsByName, { Read: 2, Bash: 1 })
  assert.equal(metrics.toolErrors, 1)
  assert.equal(metrics.toolDurationMs, 800)
  assert.equal(metrics.assistantMessages, 2)
  // Reasoning text is not output.
  assert.equal(metrics.outputChars, 'Let me look.'.length + 'Done.'.length)
  assert.equal(metrics.contextTokens, 1234)
  assert.equal(metrics.model, 'claude-sonnet-5-5')
})

test('benchmark metrics: a CLI that reports no usage yields nulls, never zeros', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'message.started', messageId: 'u1', role: 'user' }],
    [700, { type: 'message.completed', messageId: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }], parentToolCallId: null }],
    [800, { type: 'turn.completed', stopReason: 'end_turn', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
  ]))
  assert.equal(metrics.durationMs, 800)
  assert.equal(metrics.firstTextMs, 700)
  assert.equal(metrics.inputTokens, null)
  assert.equal(metrics.outputTokens, null)
  assert.equal(metrics.costUsd, null)
  assert.equal(metrics.contextTokens, null)
  assert.equal(metrics.model, null)
  assert.equal(metrics.toolCalls, 0)
})

test('benchmark metrics: an interrupted run has no duration but keeps what it consumed', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'message.started', messageId: 'u1', role: 'user' }],
    [500, { type: 'tool.started', toolCallId: 't1', name: 'Bash', input: {}, parentToolCallId: null }],
    [900, { type: 'error', code: 'benchmark_timeout', message: 'cut', recoverable: true }],
    [900, { type: 'session.ended', reason: 'interrupted' }],
  ]))
  assert.equal(metrics.durationMs, null)
  assert.equal(metrics.firstTextMs, null)
  assert.equal(metrics.toolCalls, 1)
  assert.equal(metrics.toolDurationMs, 0)
})
