import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolItem } from '../src/lib/chat-fold'
import { toolLabel, toolQualifiers, toolSummary } from '../src/lib/tool-presentation'

const advisor = (output: unknown, status: ToolItem['status'] = 'done'): ToolItem =>
  ({ kind: 'tool', id: 't', name: 'advisor', ts: 0, input: {}, output, outputBytes: null, status, durationMs: 8800, parentToolCallId: null }) as ToolItem
const usage = { inputTokens: 24831, outputTokens: 664, cacheReadTokens: 0, cacheCreationTokens: 0 }

test('an advisor consultation is labelled, summarized by the consulted model and shows its tokens', () => {
  const tool = advisor({ status: 'redacted', text: null, errorCode: null, model: 'claude-opus-5-5', usage })
  assert.equal(toolLabel(tool.name), 'Advisor')
  assert.deepEqual(toolSummary(tool), { text: 'claude-opus-5-5', mono: true })
  const pills = toolQualifiers(tool)
  assert.deepEqual(pills.map((pill) => pill.text), ['25.5 k tokens'])
  assert.match(pills[0]!.hint, /billed apart/)
})

test('a refused consultation says so; a running or unreported one invents nothing', () => {
  assert.deepEqual(toolQualifiers(advisor({ status: 'refused', text: null, errorCode: null, model: null, usage: null })).map((pill) => pill.text), ['Declined'])
  assert.equal(toolSummary(advisor(null, 'running')), null)
  assert.deepEqual(toolQualifiers(advisor(null, 'running')), [])
})
