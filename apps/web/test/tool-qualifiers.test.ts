import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolItem } from '../src/lib/chat-fold'
import { toolQualifiers } from '../src/lib/tool-presentation'

function tool(name: string, input: Record<string, unknown>): ToolItem {
  return { kind: 'tool', id: 't', name, ts: 0, input, output: null, outputBytes: null, status: 'done', durationMs: 10, parentToolCallId: null } as ToolItem
}

test('an Agent call with an effort shows the level under its translated label', () => {
  const [pill] = toolQualifiers(tool('Agent', { description: 'Audit', prompt: 'Go', effort: 'max' }))
  assert.equal(pill?.text, 'Effort: Max')
  assert.match(pill?.hint ?? '', /Max/)
  // Older CLIs name the same tool Task.
  assert.equal(toolQualifiers(tool('Task', { prompt: 'Go', effort: 'xhigh' }))[0]?.text, 'Effort: Extra high')
})

test('an unknown effort level is shown as sent rather than dropped', () => {
  assert.equal(toolQualifiers(tool('Agent', { prompt: 'Go', effort: 'turbo' }))[0]?.text, 'Effort: turbo')
})

test('an Agent call without effort, or with an empty one, adds nothing', () => {
  assert.deepEqual(toolQualifiers(tool('Agent', { prompt: 'Go' })), [])
  assert.deepEqual(toolQualifiers(tool('Agent', { prompt: 'Go', effort: ' ' })), [])
})

test('Read with allow_large says whole file, or large range when a range is given', () => {
  assert.equal(toolQualifiers(tool('Read', { file_path: '/a.ts', allow_large: true }))[0]?.text, 'Whole file')
  assert.equal(toolQualifiers(tool('Read', { file_path: '/a.ts', allow_large: true, offset: 4000 }))[0]?.text, 'Large range')
  assert.deepEqual(toolQualifiers(tool('Read', { file_path: '/a.ts', allow_large: false })), [])
  assert.deepEqual(toolQualifiers(tool('Read', { file_path: '/a.ts', allow_large: 'true' })), [])
})

test('other tools carrying the same argument names get no pill', () => {
  assert.deepEqual(toolQualifiers(tool('Bash', { command: 'ls', effort: 'max', allow_large: true })), [])
})
