import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { DEFAULT_CLAUDE_CONFIG, readAdvisorOutcome, type SillageEvent } from '@sillage/protocol'
import { advisorResult } from '../src/agents/claude/advisor.js'
import { ClaudeRunner } from '../src/agents/claude/runner.js'
import { translateTranscript } from '../src/agents/claude/transcript.js'
import { turnUsageOf } from '../src/consumption/turn-usage.js'
import type { RunnerContext } from '../src/agents/types.js'

// Shapes recorded from Claude Code 2.1.332 (sonnet consulting opus), trimmed to what is read.
const CALL = { type: 'server_tool_use', id: 'srvtoolu_01', name: 'advisor', input: {} }
const ANSWER = { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_01', content: { type: 'advisor_redacted_result', encrypted_content: 'Eq4J' } }
const ITERATIONS = [
  { type: 'message', input_tokens: 2, output_tokens: 26, cache_read_input_tokens: 11837, cache_creation_input_tokens: 11412 },
  { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 24831, output_tokens: 664, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  { type: 'message', input_tokens: 2, output_tokens: 66, cache_read_input_tokens: 23249, cache_creation_input_tokens: 422 },
]
const OPUS_USAGE = { inputTokens: 24831, outputTokens: 664, cacheReadTokens: 0, cacheCreationTokens: 0 }
const assistant = (block: unknown, usage: Record<string, unknown> = { input_tokens: 2, output_tokens: 16 }) => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { id: 'msg_01', model: 'claude-sonnet-5-5', role: 'assistant', content: [block], usage },
})

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

const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', parent_tool_use_id: null, event })

test('a live advisor consultation becomes a tool call completed with the advisor model and its usage', async (t) => {
  const f = runner()
  t.after(() => f.instance.stop())
  f.translate(stream({ type: 'message_start', message: { id: 'msg_01' } }))
  f.translate(assistant(CALL))
  const started = f.events.find((event) => event.type === 'tool.started')
  assert.ok(started?.type === 'tool.started')
  assert.equal(started.name, 'advisor')
  assert.equal(started.toolCallId, 'srvtoolu_01')
  assert.deepEqual(started.input, {})

  f.translate(assistant(ANSWER))
  f.translate(assistant({ type: 'text', text: 'parquetize' }))
  // The advisor's usage only arrives with the message's closing delta: the call waits for it.
  assert.equal(f.events.some((event) => event.type === 'tool.completed'), false)
  f.translate(stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 4, output_tokens: 92, iterations: ITERATIONS } }))

  const completed = f.events.filter((event) => event.type === 'tool.completed')
  assert.equal(completed.length, 1)
  assert.ok(completed[0]?.type === 'tool.completed')
  assert.equal(completed[0].isError, false)
  assert.deepEqual(readAdvisorOutcome(completed[0].output), {
    status: 'redacted', text: null, errorCode: null, model: 'claude-opus-5-5', usage: OPUS_USAGE,
  })
})

test('a turn ending before the message closes still completes its advisor call', async (t) => {
  const f = runner()
  t.after(() => f.instance.stop())
  f.translate(stream({ type: 'message_start', message: { id: 'msg_01' } }))
  f.translate(assistant(CALL))
  f.translate(assistant(ANSWER))
  f.translate({
    type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.16, num_turns: 1,
    usage: { input_tokens: 4, output_tokens: 92, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })
  const completed = f.events.find((event) => event.type === 'tool.completed')
  assert.ok(completed?.type === 'tool.completed')
  assert.equal(readAdvisorOutcome(completed.output)?.status, 'redacted')
  assert.equal(readAdvisorOutcome(completed.output)?.usage, null)
})

test('every advisor answer variant gets its status', () => {
  const outcome = (content: Record<string, unknown>) => advisorResult({ type: 'advisor_tool_result', tool_use_id: 'x', content })?.outcome
  assert.deepEqual(outcome({ type: 'advisor_result', text: 'Check the tests first.' }), {
    status: 'advised', text: 'Check the tests first.', errorCode: null, model: null, usage: null,
  })
  assert.equal(outcome({ type: 'advisor_result', text: 'No.', stop_reason: 'refusal' })?.status, 'refused')
  assert.equal(outcome({ type: 'advisor_redacted_result', encrypted_content: 'x', stop_reason: 'refusal' })?.status, 'refused')
  assert.deepEqual(outcome({ type: 'advisor_tool_result_error', error_code: 'overloaded' }), {
    status: 'unavailable', text: null, errorCode: 'overloaded', model: null, usage: null,
  })
  assert.equal(advisorResult({ type: 'tool_result', tool_use_id: 'x' }), null)
})

test('an imported transcript shows the consultation with the usage saved in its entry', () => {
  const usage = { input_tokens: 2, output_tokens: 16, iterations: ITERATIONS }
  const entries = [CALL, ANSWER, { type: 'text', text: 'parquetize' }].map((block, index) => ({
    ...assistant(block, usage), uuid: `u${index}`, timestamp: new Date(Date.UTC(2026, 10, 27, 18, 49, 26 + index * 9)).toISOString(),
  }))
  const { events } = translateTranscript(entries, '/workspace')
  const started = events.find(({ event }) => event.type === 'tool.started')?.event
  const completed = events.find(({ event }) => event.type === 'tool.completed')?.event
  assert.ok(started?.type === 'tool.started' && started.name === 'advisor')
  assert.ok(completed?.type === 'tool.completed')
  assert.equal(completed.durationMs, 9000)
  assert.deepEqual(readAdvisorOutcome(completed.output), {
    status: 'redacted', text: null, errorCode: null, model: 'claude-opus-5-5', usage: OPUS_USAGE,
  })
})

test('the advisor model is billed in the turn consumption, apart from the main model', () => {
  const counters = (input: number, output: number, cost: number) => ({
    inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0, costUSD: cost,
  })
  const result = {
    type: 'result',
    usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } },
    model_usage_since_last_result: { 'claude-sonnet-5-5': counters(4, 92, 0.0511396), 'claude-opus-5-5': counters(24831, 664, 0.112604) },
  }
  const turn = { type: 'turn.completed', stopReason: 'success', costUsd: 0.16, inputTokens: 4, outputTokens: 92, cacheCreationTokens: 0, cacheReadTokens: 0 } as const
  const { rows } = turnUsageOf('claude', turn, result, { model: 'claude-sonnet-5-5', claude: null })
  const opus = rows.find((row) => row.model === 'claude-opus-5-5')
  assert.equal(opus?.inputTokens, 24831)
  assert.equal(opus?.reportedCostUsd, 0.112604)
})

test('a turn\'s tokens include its sub-agents and advisor, like its cost (card #130)', async (t) => {
  const f = runner()
  t.after(() => f.instance.stop())
  const model = (input: number, output: number, read: number, written: number, cost: number) => ({
    inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: written, cacheCreationEphemeral1hInputTokens: 0, costUSD: cost,
  })
  // Recorded from Claude Code 2.1.332, Haiku consulting a Sonnet advisor: `usage` is Haiku's main loop alone.
  f.translate({
    type: 'result', subtype: 'success', is_error: false, result: '4', total_cost_usd: 0.0552, num_turns: 1,
    usage: { input_tokens: 4, output_tokens: 76, cache_creation_input_tokens: 10009, cache_read_input_tokens: 32324 },
    model_usage_since_last_result: { 'claude-haiku-5-5': model(1205, 95, 32324, 10009, 0.002463565), 'claude-sonnet-5-5': model(22585, 759, 0, 0, 0.05276) },
  })
  const completed = f.events.find((event) => event.type === 'turn.completed')
  assert.ok(completed?.type === 'turn.completed')
  assert.deepEqual(
    { input: completed.inputTokens, output: completed.outputTokens, read: completed.cacheReadTokens, written: completed.cacheCreationTokens },
    { input: 23790, output: 854, read: 32324, written: 10009 },
  )
  assert.ok(Math.abs(completed.costUsd - 0.055223565) < 1e-9)
})

test('without per-turn model counters, a turn keeps the main loop\'s usage', async (t) => {
  const f = runner()
  t.after(() => f.instance.stop())
  f.translate({
    type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.01, num_turns: 1,
    usage: { input_tokens: 4, output_tokens: 76, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
  })
  const completed = f.events.find((event) => event.type === 'turn.completed')
  assert.ok(completed?.type === 'turn.completed')
  assert.deepEqual([completed.inputTokens, completed.outputTokens, completed.cacheCreationTokens, completed.cacheReadTokens], [4, 76, 10, 20])
})
