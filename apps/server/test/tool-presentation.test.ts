import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countTextChanges } from '@sillage/protocol'
import type { ThreadItem } from '@sillage/codex-bindings/v2'
import type { ToolItem } from '../../web/src/lib/chat-fold.js'
import { describeTool as opencodeTool } from '../src/agents/opencode/tools.js'
import { describeTool as grokTool } from '../src/agents/grok/tools.js'
import { startedItem, completedItem } from '../src/agents/codex/item-events.js'
import { toolEdits } from '../../web/src/lib/tool-edits.js'
import { outputText } from '../../web/src/lib/tool-payload.js'

Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'en' }, configurable: true })
const { toolSummary, toolOrigin, toolPreview } = await import('../../web/src/lib/tool-presentation.js')
const { applyEvent, emptyChatState } = await import('../../web/src/lib/chat-fold.js')
const tool = (name: string, input: unknown, output: unknown = null): ToolItem => ({
  kind: 'tool', id: 'edit', ts: 0, name, input, output, outputBytes: null, status: 'done', durationMs: 10, parentToolCallId: null,
})

const before = 'keep\nold\nend\n'
const after = 'keep\nnew\nextra\nend\n'

test('Claude, OpenCode and Grok edits share paths and changed-line counts after normalization', () => {
  const native = [
    { name: 'Edit', input: { file_path: 'src/a.ts', old_string: before, new_string: after } },
    opencodeTool('edit', { filePath: 'src/a.ts', oldString: before, newString: after }, []),
    grokTool('search_replace', { variant: 'SearchReplace', path: 'src/a.ts', old_string: before, new_string: after }),
  ]
  for (const entry of native) {
    const item = tool(entry.name, entry.input)
    assert.equal(toolSummary(item)?.text, 'src/a.ts')
    assert.deepEqual(toolEdits(item)?.counts, { added: 2, removed: 1 })
    assert.equal(toolEdits(item)?.scope, 'fragment')
  }
  const repeated = tool('Edit', { file_path: 'a', old_string: before, new_string: after, replace_all: true })
  assert.equal(toolEdits(repeated)?.scope, 'replacement')
})

test('Codex final file changes survive replay without an intermediate patch notification', () => {
  const changes = [
    { path: 'changed.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+extra\n end' },
    { path: 'added.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' },
    { path: 'deleted.ts', kind: { type: 'delete' }, diff: 'one\n' },
  ]
  const start = { type: 'fileChange', id: 'edit', status: 'inProgress', changes: [] } as ThreadItem
  const end = { ...start, status: 'completed', changes } as ThreadItem
  const events = [...startedItem(start, null), ...completedItem(end, '/project', 10, null)]
  const state = events.reduce((s, event, i) => applyEvent(s, i + 1, i, event), emptyChatState())
  const item = state.items.find((item): item is ToolItem => item.kind === 'tool')!
  assert.deepEqual(toolEdits(item)?.counts, { added: 4, removed: 2 })
  assert.deepEqual(toolEdits(item)?.paths, ['changed.ts', 'added.ts', 'deleted.ts'])
  assert.deepEqual((item.input as { changes: unknown }).changes, changes)
  // Older replay may retain the final array only in output.
  assert.deepEqual(toolEdits(tool('Edit', { changes: [] }, changes))?.counts, { added: 4, removed: 2 })
})

test('OpenCode apply_patch has paths and counts without counting context or invented deletions', () => {
  const patch = '*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n keep\n-old\n+new\n+extra\n*** Add File: added.ts\n+one\n+two\n*** End Patch'
  const described = opencodeTool('apply_patch', { patchText: patch }, [])
  const item = tool(described.name, described.input)
  assert.equal(toolSummary(item)?.text, 'new.ts · added.ts')
  assert.deepEqual(toolEdits(item)?.counts, { added: 4, removed: 1 })
  assert.equal(toolEdits(tool('ApplyPatch', { patch: '*** Begin Patch\n*** Delete File: deleted.ts\n*** End Patch' }))?.counts, null)
})

test('line counts handle empty strings, final newlines, CRLF, unchanged context and bounded work', () => {
  for (const [a, b, expected] of [
    ['', '', { added: 0, removed: 0 }], ['', 'one\n', { added: 1, removed: 0 }],
    ['one\r\ntwo\r\n', 'one\r\nnew\r\n', { added: 1, removed: 1 }],
    ['one\ntwo', 'one\ntwo', { added: 0, removed: 0 }],
    ['one\n', '', { added: 0, removed: 1 }],
    ['same\na\nsame\nb\nsame', 'same\nc\nsame\nd\nsame', { added: 2, removed: 2 }],
  ] as const) assert.deepEqual(countTextChanges(a, b), expected)
  assert.equal(countTextChanges('old\n'.repeat(2000), 'new\n'.repeat(2000)), null)
  assert.deepEqual(countTextChanges('same\n'.repeat(10000) + 'old', 'same\n'.repeat(10000) + 'new'), { added: 1, removed: 1 })
  assert.equal(countTextChanges('x'.repeat(1_000_001), ''), null)
})

test('malformed and unavailable edits do not invent counters or break the thread', () => {
  for (const input of [null, 'opaque', { changes: [] }, { changes: [null, {}] }, { changes: [{ path: 'a', diff: 'unknown', kind: { type: 'update' } }] }]) {
    assert.equal(toolEdits(tool('Edit', input))?.counts ?? null, null)
  }
  assert.equal(toolEdits(tool('Write', { file_path: 'a' }))?.counts, null)
})

test('MCP origins and text blocks survive all adapter encodings without misclassifying native tools', () => {
  for (const item of [
    tool('mcp__sillage__read_memory', { file: 'project.md' }),
    tool('sillage/read_memory', { file: 'project.md' }),
    tool(...Object.values(opencodeTool('sillage_read_memory', { file: 'project.md' }, ['sillage'])) as [string, unknown]),
    tool(...Object.values(grokTool('use_tool', { tool_name: 'sillage__read_memory', tool_input: { file: 'project.md' } })) as [string, unknown]),
  ]) {
    assert.equal(toolOrigin(item.name).kind, 'sillage')
    assert.equal(toolSummary(item)?.text, 'project.md')
  }
  assert.equal(toolOrigin(opencodeTool('git_hub_issue_read', {}, ['git', 'git_hub']).name).server, 'git_hub')
  assert.equal(toolOrigin('Collaboration/spawnAgent').kind, 'native')
  assert.equal(toolOrigin('Codex/futureTool').kind, 'native')
  assert.equal(toolOrigin('apply_patch').kind, 'native')
  for (const output of ['Found', [{ type: 'text', text: 'Found' }], { content: [{ type: 'text', text: 'Found' }], structuredContent: null }]) {
    assert.equal(outputText(output), 'Found')
    assert.equal(toolPreview(tool('sillage/read_memory', {}, output)), 'Found')
  }
  assert.equal(outputText({ content: [null, { type: 'image', data: 'image' }] }), null)
})

test('search summaries prefer the query over its directory, with numeric MCP IDs and notebook paths', () => {
  assert.equal(toolSummary(tool('Grep', { path: '/workspace', pattern: 'needle' }))?.text, 'needle')
  assert.equal(toolSummary(tool('NotebookEdit', { notebook_path: 'analysis.ipynb' }))?.text, 'analysis.ipynb')
  assert.equal(toolSummary(tool('sillage/read_card', { card_number: 53 }))?.text, '#53')
  assert.equal(toolSummary(tool('sillage/read_card', { number: 45 }))?.text, '#45')
  assert.equal(toolSummary(tool('Skill', { skill: 'frontend-design' }))?.text, 'frontend-design')
})


test('Write counts lines written across adapters without claiming a net diff', () => {
  for (const entry of [
    { name: 'Write', input: { file_path: 'a.ts', content: 'one\ntwo\n' } },
    opencodeTool('write', { filePath: 'a.ts', content: 'one\ntwo\n' }, []),
    grokTool('write', { target_file: 'a.ts', content: 'one\r\ntwo\r\n' }),
  ]) {
    const item = tool(entry.name, entry.input)
    assert.equal(toolSummary(item)?.text, 'a.ts')
    assert.deepEqual(toolEdits(item)?.counts, { added: 2, removed: 0 })
    assert.equal(toolEdits(item)?.scope, 'written')
  }
  assert.deepEqual(toolEdits(tool('Write', { content: '' }))?.counts, { added: 0, removed: 0 })
  assert.deepEqual(toolEdits(tool('Write', { content: 'last line' }))?.counts, { added: 1, removed: 0 })
  assert.equal(toolEdits(tool('Write', { content: null }))?.counts, null)
})
