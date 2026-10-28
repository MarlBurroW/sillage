import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countTextChanges, sillageEventSchema, toolPresentation } from '@sillage/protocol'
import type { ThreadItem } from '@sillage/codex-bindings/v2'
import type { ToolItem } from '../../web/src/lib/chat-fold.js'
import { describeTool as opencodeTool } from '../src/agents/opencode/tools.js'
import { describeTool as grokTool } from '../src/agents/grok/tools.js'
import { startedItem, completedItem } from '../src/agents/codex/item-events.js'
import { toolEdits } from '../../web/src/lib/tool-edits.js'
import { toolWebInput } from '../../web/src/lib/tool-web-input.js'
import { outputText } from '../../web/src/lib/tool-payload.js'

Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'en' }, configurable: true })
const { toolSummary, toolOrigin, toolPreview, toolLabel } = await import('../../web/src/lib/tool-presentation.js')
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
    tool('sillage_builtin/read_memory', { file: 'project.md' }),
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


test('Codex final web arguments replace the empty start in live folding and replay', () => {
  const start = { type: 'webSearch', id: 'web', query: '', action: null, results: null } satisfies ThreadItem
  const cases = [
    { query: 'fallback query', action: { type: 'search', query: null, queries: null }, summary: 'fallback query' },
    { query: 'summary', action: { type: 'search', query: 'actual query', queries: null }, summary: 'actual query' },
    { query: '', action: { type: 'search', query: null, queries: ['first query', 'second query'] }, summary: 'first query · second query' },
    { query: "'stream-json'", action: { type: 'findInPage', url: null, pattern: 'stream-json' }, summary: 'stream-json' },
    { query: 'open', action: { type: 'openPage', url: 'https://example.com/docs' }, summary: 'https://example.com/docs' },
    { query: 'future action', action: { type: 'other' }, summary: 'future action' },
    { query: 'query without action', action: null, summary: 'query without action' },
  ] as const
  for (const sample of cases) {
    const final = { ...start, query: sample.query, action: sample.action, results: [{ type: 'text_result', snippet: 'Found result' }] } as ThreadItem
    const completed = completedItem(final, '/project', 12, null)
    assert.equal(completed[0].type, 'tool.input_updated')
    assert.equal(completed[1].type, 'tool.completed')
    const events = [...startedItem(start, null), ...completed]
    const replay = (entries: typeof events) => entries.reduce((state, event, i) => applyEvent(state, i + 1, i, event), emptyChatState()).items.find((item): item is ToolItem => item.kind === 'tool')!
    for (const item of [replay(events), replay(JSON.parse(JSON.stringify(events)))]) {
      assert.equal(item.status, 'done')
      // Summary must already work with output absent, as in a collapsed projected journal.
      assert.equal(toolSummary({ ...item, output: null })?.text, sample.summary)
      assert.equal((item.input as Record<string, unknown>).type, sample.action?.type)
      if (sample.action?.type === 'search') assert.deepEqual((item.input as Record<string, unknown>).queries, sample.action.queries)
    }
    const legacy = tool('WebSearch', { query: '' }, { query: sample.query, action: sample.action, results: [] })
    assert.deepEqual(toolWebInput(legacy), replay(events).input)
    assert.equal(toolSummary(legacy)?.text, sample.summary)
  }
})

test('web input recovery leaves other CLIs, running calls and unavailable bodies untouched', () => {
  const input = { query: 'original query' }
  const output = { query: 'final query', action: { type: 'search', query: null, queries: null }, results: [] }
  for (const item of [
    tool('WebSearch', input, 'Text results'), tool('WebSearch', input, null),
    tool('WebSearch', input, { query: 'unrelated object' }), tool('github/search', input, output),
    { ...tool('WebSearch', input, output), status: 'running' as const },
    tool('WebSearch', input, { ...output, action: { type: 'unknown' } }),
  ]) assert.equal(toolWebInput(item), input)
  assert.equal((toolWebInput(tool('WebFetch', {}, { ...output, action: { type: 'openPage', url: 'https://example.com' } })) as Record<string, unknown>).url, 'https://example.com')
})


test('human call metadata wins without confusing a resource description with an activity', () => {
  assert.equal(toolSummary({ ...tool('Bash', { command: 'tail -20 test.log', description: 'Read the test report' }), presentation: { title: 'Shell command' } })?.text, 'Read the test report')
  assert.equal(toolSummary({ ...tool('Bash', { command: 'tail -20 test.log', description: '  ' }), presentation: { title: 'Read the test report' } })?.text, 'Read the test report')
  assert.equal(toolSummary({ ...tool('Read', {}), presentation: { paths: ['src/a.ts'] } })?.text, 'src/a.ts')
  assert.equal(toolSummary(tool('sillage/create_card', { title: 'Repair search', description: 'Long ticket body' }))?.text, 'Repair search')
  assert.equal(toolSummary(tool('TaskCreate', { subject: 'Check tests', description: 'Long task body' }))?.text, 'Check tests')
  assert.equal(toolSummary(tool('TaskUpdate', { taskId: '7', status: 'completed' }))?.text, '#7')
  assert.equal(toolSummary(tool('TaskOutput', { task_id: 'background-1' }))?.text, '#background-1')
  assert.equal(toolSummary(tool('ReadMcpResource', { server: 'docs', uri: 'docs://guide' }))?.text, 'docs://guide')
  assert.equal(toolSummary(tool('Hook/PreToolUse', { source: '/hooks/check.sh' }))?.text, '/hooks/check.sh')
  assert.equal(toolOrigin('Hook/PreToolUse').kind, 'native')
  assert.equal(toolOrigin('functions/custom_tool', { origin: 'native' }).kind, 'native')
  assert.equal(toolSummary(tool('Sleep', { durationMs: 1200 }))?.text, 'Wait 1.2 s')
  assert.deepEqual(toolPresentation('read_file', ['read_file', 'Read']), {})
  assert.deepEqual(toolPresentation(' Read the source ', ['Read'], [null, { path: 42 }, { path: 'src/a.ts' }, { path: 'src/a.ts' }]), { title: 'Read the source', paths: ['src/a.ts'] })
})

test('common read, shell, search, task and skill inputs retain their identifying fields across adapters', () => {
  for (const [native, open, grok, inputs, expected] of [
    ['Read', 'read', 'read_file', [{ file_path: 'a.ts' }, { filePath: 'a.ts' }, { target_file: 'a.ts' }], 'a.ts'],
    ['Bash', 'bash', 'run_terminal_command', [{ command: 'echo hi', description: 'Say hello' }, { command: 'echo hi' }, { command: 'echo hi', description: 'Say hello' }], ['Say hello', 'echo hi', 'Say hello']],
    ['Grep', 'grep', 'grep', [{ pattern: 'needle', path: '/src' }, { pattern: 'needle', path: '/src' }, { query: 'needle', target_directory: '/src' }], 'needle'],
    ['WebSearch', 'websearch', 'web_search', [{ query: 'release notes' }, { query: 'release notes' }, { query: 'release notes' }], 'release notes'],
    ['WebFetch', 'webfetch', 'web_fetch', [{ url: 'https://example.com/guide' }, { url: 'https://example.com/guide' }, { url: 'https://example.com/guide' }], 'https://example.com/guide'],
    ['Agent', 'task', 'spawn_subagent', [{ description: 'Explore tests', prompt: 'Long prompt' }, { description: 'Explore tests', prompt: 'Long prompt' }, { description: 'Explore tests', prompt: 'Long prompt' }], 'Explore tests'],
  ] as const) {
    for (const [index, described] of [{ name: native, input: inputs[0] }, opencodeTool(open, inputs[1], []), grokTool(grok, inputs[2])].entries()) {
      assert.equal(toolSummary(tool(described.name, described.input))?.text, typeof expected === 'string' ? expected : expected[index], described.name)
    }
  }
  const listing = grokTool('list_dir', { target_directory: 'src' })
  assert.equal(toolSummary(tool(listing.name, listing.input))?.text, 'src')
  const glob = opencodeTool('glob', { pattern: '**/*.tsx' }, [])
  assert.equal(toolSummary(tool(glob.name, glob.input))?.text, '**/*.tsx')
  const skill = opencodeTool('skill', { name: 'frontend-design' }, [])
  assert.equal(toolSummary(tool(skill.name, skill.input))?.text, 'frontend-design')
})

test('Codex command parsing describes known actions and falls back for compound or unknown commands', () => {
  for (const [action, expected] of [
    [{ type: 'read', path: 'src/a.ts', name: 'a.ts' }, 'Read src/a.ts'],
    [{ type: 'listFiles', path: 'src' }, 'List files in src'],
    [{ type: 'search', path: 'src', query: 'needle' }, 'Search for needle in src'],
    [{ type: 'search', path: null, query: 'needle' }, 'Search for needle'],
    [{ type: 'unknown' }, 'shell command'], [null, 'shell command'],
  ] as const) assert.equal(toolSummary(tool('Bash', { command: 'shell command', commandActions: [action] }))?.text, expected)
  assert.equal(toolSummary(tool('Bash', { command: 'cat a; echo done', commandActions: [{ type: 'read', path: 'a' }, { type: 'unknown' }] }))?.text, 'cat a; echo done')
})

test('final Codex command, MCP, dynamic and image inputs retain metadata through schema and folding', () => {
  const cases = [
    [{ type: 'commandExecution', command: '', cwd: '/project' }, { command: 'cat a.ts', commandActions: [{ type: 'read', command: 'cat a.ts', path: 'a.ts', name: 'a.ts' }], aggregatedOutput: 'source', status: 'completed' }, 'Read a.ts'],
    [{ type: 'mcpToolCall', server: 'github', tool: 'search', arguments: {} }, { arguments: { query: 'bugs' }, appContext: { actionName: 'Search issues' }, result: { content: [] } }, 'bugs'],
    [{ type: 'dynamicToolCall', namespace: 'functions', tool: 'custom', arguments: {} }, { arguments: { path: 'a.ts' }, contentItems: [], status: 'completed' }, 'a.ts'],
    [{ type: 'imageGeneration', revisedPrompt: null, result: '' }, { revisedPrompt: 'A forest', result: '', status: 'completed' }, 'A forest'],
  ]
  for (const [initial, final, expected] of cases) {
    const start = { ...initial as object, id: 'call' } as ThreadItem
    const end = { ...start, ...final as object } as ThreadItem
    const events = [...startedItem(start, null), ...completedItem(end, '/project', 10, null)].map(event => sillageEventSchema.parse(event))
    const state = events.reduce((state, event, i) => applyEvent(state, i + 1, i, event), emptyChatState())
    const item = state.items.find((item): item is ToolItem => item.kind === 'tool')!
    assert.equal(toolSummary(item)?.text, expected)
    if (end.type === 'mcpToolCall') assert.equal(toolLabel(item.name, item.presentation), 'Search issues')
    if (end.type === 'dynamicToolCall') assert.equal(toolOrigin(item.name, item.presentation).kind, 'native')
  }
})

test('Antigravity action titles survive replay and partial updates alongside presentation metadata', () => {
  let state = emptyChatState()
  const emit = (event: unknown, seq: number) => { state = applyEvent(state, seq, seq, sillageEventSchema.parse(event)) }
  emit({ type: 'tool.started', toolCallId: 'google', name: 'sillage/create_card', title: 'Record the discovered issue', input: { description: 'Resource body' }, parentToolCallId: null }, 1)
  const current = () => state.items.find((item): item is ToolItem => item.kind === 'tool')!
  assert.equal(toolSummary(current())?.text, 'Record the discovered issue')
  emit({ type: 'tool.input_updated', toolCallId: 'google', input: { description: 'Updated body' }, presentation: { origin: 'mcp' } }, 2)
  assert.equal(toolSummary(current())?.text, 'Record the discovered issue')
  emit({ type: 'tool.input_updated', toolCallId: 'google', input: { description: 'Updated body' }, title: 'Save the follow-up' }, 3)
  assert.equal(toolSummary(current())?.text, 'Save the follow-up')
  assert.equal(current().presentation?.origin, 'mcp')
  emit({ type: 'tool.input_updated', toolCallId: 'google', input: { query: 'remaining work' }, title: null }, 4)
  assert.equal(toolSummary(current())?.text, 'remaining work')
})
