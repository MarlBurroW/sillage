import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SillageEvent } from '@sillage/protocol'
import { applyEvent, describeActivity, emptyChatState, type ToolItem } from '../src/lib/chat-fold'
import { sequenceIntents, toolActivity, toolIntent } from '../src/lib/tool-presentation'

function tool(name: string, input: Record<string, unknown> = {}): ToolItem {
  return { kind: 'tool', id: name, name, ts: 0, input, output: null, outputBytes: null, status: 'done', durationMs: 10, parentToolCallId: null } as ToolItem
}

function fold(events: SillageEvent[]) {
  return events.reduce((state, event, index) => applyEvent(state, index + 1, index + 1, event), emptyChatState())
}

test('a Codex shell command that only reads, lists or searches explores the project', () => {
  const read = { type: 'read', path: 'src/a.ts', name: 'a.ts' }
  assert.equal(toolIntent(tool('Bash', { command: 'cat src/a.ts', commandActions: [read] })), 'inspect')
  assert.equal(toolIntent(tool('Bash', { command: 'rg x && ls', commandActions: [{ type: 'search', query: 'x' }, { type: 'listFiles', path: '.' }] })), 'inspect')
  // One unparsed part is enough to make it an arbitrary command.
  assert.equal(toolIntent(tool('Bash', { command: 'cat a && rm b', commandActions: [read, { type: 'unknown', cmd: 'rm b' }] })), 'other')
  assert.equal(toolIntent(tool('Bash', { command: 'make', commandActions: [] })), 'other')
  assert.equal(toolIntent(tool('Bash', { command: 'pnpm test' })), 'verify')
})

test('a sequence names its kinds of work once, in order, without "other actions"', () => {
  const tools = [tool('Read'), tool('mcp__github__search_issues'), tool('Edit'), tool('Grep'), tool('Bash', { command: 'pnpm lint' })]
  assert.equal(sequenceIntents(tools), 'Explore and read · Make changes · Run checks')
  assert.equal(sequenceIntents([tool('Bash', { command: 'make' })]), '')
})

test('Minimal words a running call by its kind of work, the other styles by the tool', () => {
  const state = fold([
    { type: 'turn.started' },
    { type: 'tool.started', toolCallId: 'grep', name: 'Grep', input: { pattern: 'login' }, parentToolCallId: null },
  ])
  assert.equal(describeActivity(state), 'Grep running')
  assert.equal(describeActivity(state, toolActivity), 'Reading and exploring')
  const mcp = fold([
    { type: 'turn.started' },
    { type: 'tool.started', toolCallId: 'issue', name: 'mcp__github__search_issues', input: { query: 'bug' }, parentToolCallId: null },
  ])
  assert.equal(describeActivity(mcp, toolActivity), 'Working')
  assert.equal(toolActivity(tool('mcp__sillage__read_memory')), 'Checking the project')
  assert.equal(toolActivity(tool('Write', { file_path: 'a.ts', content: 'x' })), 'Making changes')
})
