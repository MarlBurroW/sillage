import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DEFAULT_COPILOT_CONFIG, isPermissiveConfig, sillageEventSchema, type CopilotConfig, type SillageEvent } from '@sillage/protocol'
import { describeEdit } from '../src/agents/acp/content.js'
import { CopilotCatalog } from '../src/agents/copilot/catalog.js'
import { copilotLaunch, modeOf, skillDirs } from '../src/agents/copilot/launch.js'
import { CopilotRunner } from '../src/agents/copilot/runner.js'
import { describeCopilotTool } from '../src/agents/copilot/tools.js'
import type { RunnerContext } from '../src/agents/types.js'

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 5)) }
}

async function fixture(t: TestContext, changes: Partial<RunnerContext> = {}, config: Partial<CopilotConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sillage-copilot-'))
  const binary = join(root, 'agent.mjs')
  await copyFile(new URL('./fixtures/copilot-agent.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)
  const events: SillageEvent[] = [], raw: unknown[] = [], configs: CopilotConfig[] = []
  const ctx: RunnerContext = {
    conversationId: `conversation-${randomUUID()}`, cwd: root, binary, config: { ...DEFAULT_COPILOT_CONFIG, ...config }, attachmentsRoot: root, resumeSessionId: null,
    projectOverview: () => 'Shared instructions and memory', maskedInstructionRoots: () => [], memoryDir: () => null, skillRoots: () => [], resolveMcpServers: () => ({ servers: [], failures: [] }),
    emit: (event, native) => { sillageEventSchema.parse(event); events.push(event); raw.push(native) }, setStatus: () => {}, setAgentSessionId: () => {},
    updateConfig: (next) => { configs.push(next as CopilotConfig) }, openPermissionRequest: () => randomUUID(), closePermissionRequest: () => {}, ...changes,
  }
  const runner = new CopilotRunner(ctx)
  t.after(async () => { await runner.stop(); await rm(root, { recursive: true, force: true }) })
  await runner.start()
  const rpc = async () => (await readFile(join(root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const turn = async (steps: unknown[], usage = {}) => {
    const count = events.filter((entry) => entry.type === 'turn.completed').length
    await runner.send('fixture:' + JSON.stringify({ steps, usage }), [], [], [])
    await until(() => events.filter((entry) => entry.type === 'turn.completed').length > count)
  }
  return { root, binary, ctx, runner, events, raw, configs, rpc, turn }
}

test('Copilot catalog puts Auto first, merges its two entries and reads per-model efforts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-copilot-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'agent.mjs')
  await copyFile(new URL('./fixtures/copilot-agent.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)
  const listing = await new CopilotCatalog(async () => binary).list()
  assert.deepEqual(listing.models.models.map((model) => [model.value, model.hint, model.isDefault]), [['auto', 'auto · 0.9x', true], ['gpt-test', 'gpt-test · 1x', false]])
  assert.deepEqual(listing.models.models[0]!.efforts, [])
  assert.deepEqual(listing.models.models[1]!.efforts.map((effort) => effort.value), ['low', 'medium', 'high'])
  assert.equal(listing.models.models[1]!.defaultEffort, 'medium')
  // `/model` changes state Sillage tracks, `/cwd` would leave the conversation's directory.
  assert.deepEqual(listing.commands.map((command) => command.name), ['compact', 'usage'])
})

test('Copilot launch passes the Auto profile only for Auto, skills one by one and the instructions folder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-copilot-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'skills', 'release-notes'), { recursive: true })
  await writeFile(join(root, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Notes\n---\nBody\n')
  await mkdir(join(root, 'skills', 'empty'), { recursive: true })
  assert.deepEqual(skillDirs([root, join(root, 'missing')]), [join(root, 'skills', 'release-notes')])
  const auto = copilotLaunch({ ...DEFAULT_COPILOT_CONFIG, model: 'auto', autoTier: 'intelligence' }, { skillRoots: [root], directories: ['/extra', '/extra'], instructionsDir: '/instructions' })
  assert.deepEqual(auto.args, ['--acp', '--no-auto-update', '--disable-client-telemetry', '--auto-tier', 'intelligence', '--add-dir', '/extra', '--plugin-dir', join(root, 'skills', 'release-notes')])
  assert.equal(auto.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, '/instructions')
  assert.equal(auto.env.COPILOT_AUTO_UPDATE, 'false')
  const fixed = copilotLaunch({ ...DEFAULT_COPILOT_CONFIG, model: 'gpt-test', autoTier: 'intelligence' }, { skillRoots: [], directories: [], instructionsDir: null })
  assert.ok(!fixed.args.includes('--auto-tier'))
  assert.equal(fixed.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, undefined)
})

test('Copilot tools are recognized from kind, title and input shape', () => {
  assert.deepEqual(describeCopilotTool({ kind: 'read', title: 'Viewing /p/a.txt', rawInput: { path: '/p/a.txt' } }), { name: 'Read', input: { file_path: '/p/a.txt' }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'execute', title: 'ls -la', rawInput: { command: 'ls -la', description: 'List directory contents' } }), { name: 'Bash', input: { command: 'ls -la', description: 'List directory contents' }, title: 'List directory contents' })
  assert.deepEqual(describeCopilotTool({ kind: 'edit', title: 'apply_patch', rawInput: '*** Begin Patch\n*** Update File: /p/a.txt\n@@\n-a\n+b\n*** End Patch\n' }).input.file_path, '/p/a.txt')
  assert.equal(describeCopilotTool({ kind: 'edit', title: 'apply_patch', rawInput: '*** Begin Patch\n*** Add File: /p/new.txt\n+x\n*** End Patch\n' }).name, 'Write')
  assert.equal(describeCopilotTool({ kind: 'edit', title: 'Create file', rawInput: { fileName: '/p/new.txt', diff: '--- a/dev/null\n+++ b/p/new.txt\n' } }).name, 'Write')
  assert.deepEqual(describeCopilotTool({ kind: 'other', title: "Searching for 'bye'", rawInput: { pattern: 'bye', paths: '/p', output_mode: 'content', '-n': true } }), { name: 'Grep', input: { pattern: 'bye', path: '/p', output_mode: 'content' }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'read', title: 'Finding files matching *.txt', rawInput: { pattern: '*.txt', paths: '/p' } }), { name: 'Glob', input: { pattern: '*.txt', path: '/p' }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'fetch', title: 'Fetching https://example.com', rawInput: { url: 'https://example.com' } }), { name: 'WebFetch', input: { url: 'https://example.com' }, title: null })
  assert.equal(describeCopilotTool({ kind: 'other', title: 'sillage-create_card', rawInput: {}, _meta: { mcp: { server: 'sillage', tool: 'create_card' } } }).name, 'sillage/create_card')
})

test('Copilot streams thoughts, tools, a permissioned edit and ACP usage', async (t) => {
  const f = await fixture(t)
  const file = join(f.root, 'a.txt')
  const answered = f.turn([
    { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking' } } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: `Viewing ${file}`, kind: 'read', status: 'pending', rawInput: { path: file }, locations: [{ path: file }] } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: { content: 'a\n', detailedContent: 'diff' } } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'apply_patch', kind: 'edit', status: 'pending', rawInput: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n` } },
    { permission: { toolCall: { toolCallId: 'edit', title: 'Update file', kind: 'edit', status: 'pending', rawInput: { fileName: file, diff: '-a\n+b\n' }, locations: [{ path: file }] }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }] } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [{ type: 'diff', path: file, oldText: 'a\n', newText: 'b\n' }], rawOutput: { content: `Modified 1 file(s): ${file}` } } },
    { update: { sessionUpdate: 'usage_update', used: 100, size: 1000 } },
    { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } },
  ], { inputTokens: 2, outputTokens: 3, thoughtTokens: 5, cachedReadTokens: 7, cachedWriteTokens: 1 })
  await until(() => f.events.some((event) => event.type === 'permission.requested'))
  const request = f.events.find((event) => event.type === 'permission.requested')!
  assert.equal(request.type === 'permission.requested' && request.toolName, 'Edit')
  f.runner.resolvePermission(request.type === 'permission.requested' ? request.requestId : '', { decision: 'allowed', scope: 'session', decidedBy: null })
  await answered
  assert.deepEqual(f.events.filter((event) => event.type === 'tool.started').map((event) => event.type === 'tool.started' && event.name), ['Read', 'Edit'])
  assert.ok(f.events.some((event) => event.type === 'tool.completed' && event.toolCallId === 'read' && event.output === 'a\n'))
  assert.deepEqual((await f.rpc()).filter((entry) => 'answer' in entry).map((entry) => entry.answer), [{ outcome: { outcome: 'selected', optionId: 'allow_always' } }])
  assert.ok(f.events.some((event) => event.type === 'file.edited' && event.path === 'a.txt' && event.action === 'modified'))
  const completed = f.events.findIndex((event) => event.type === 'tool.completed' && event.toolCallId === 'edit')
  assert.match(describeEdit(f.raw[completed], f.root, 'a.txt').patch, /\+b/)
  assert.ok(f.events.some((event) => event.type === 'thinking.delta' && event.text === 'Checking'))
  assert.ok(f.events.some((event) => event.type === 'usage.updated' && event.context?.usedTokens === 100))
  const end = f.events.find((event) => event.type === 'turn.completed')!
  assert.ok(end.type === 'turn.completed')
  assert.equal(end.inputTokens, 2); assert.equal(end.outputTokens, 8); assert.equal(end.cacheReadTokens, 7); assert.equal(end.cacheCreationTokens, 1)
  // `/cwd` would move the session out of the conversation's directory.
  assert.deepEqual(f.events.filter((event) => event.type === 'commands.updated').at(-1)?.type === 'commands.updated' ? (f.events.filter((event) => event.type === 'commands.updated').at(-1) as { commands: { name: string }[] }).commands.map((command) => command.name) : [], ['compact', 'usage'])
  const launch = JSON.parse(await readFile(join(f.root, 'launch.json'), 'utf8'))
  const instructions = await readFile(join(launch.instructions, '.github', 'instructions', 'sillage.instructions.md'), 'utf8')
  assert.match(instructions, /^---\napplyTo: "\*\*"\n---\nShared instructions and memory/)
})

test('Copilot applies model, effort, mode and permissions as session options, live', async (t) => {
  const f = await fixture(t, {}, { model: 'gpt-test', reasoningEffort: 'high', mode: 'plan', allowAll: 'auto' })
  const sets = (await f.rpc()).filter((entry) => entry.method === 'session/set_config_option').map((entry) => [entry.params.configId, entry.params.value])
  // The effort option appears only once the model that has one is selected.
  assert.deepEqual(sets, [['model', 'gpt-test'], ['reasoning_effort', 'high'], ['mode', 'https://agentclientprotocol.com/protocol/session-modes#plan'], ['allow_all', 'auto']])
  assert.equal(await f.runner.applyConfig({ ...f.ctx.config as CopilotConfig, model: 'gpt-test', reasoningEffort: 'low', mode: 'agent', allowAll: 'off' }), true)
  assert.equal(f.configs.at(-1)?.reasoningEffort, 'low')
  assert.equal(f.configs.at(-1)?.mode, 'agent')
  // The Auto profile is read at launch: changing it needs a restart.
  assert.equal(await f.runner.applyConfig({ ...f.ctx.config as CopilotConfig, model: 'auto', autoTier: 'balance' }), false)
  assert.equal(modeOf('https://agentclientprotocol.com/protocol/session-modes#autopilot'), 'autopilot')
  assert.equal(isPermissiveConfig({ ...DEFAULT_COPILOT_CONFIG, mode: 'autopilot' }), true)
  assert.equal(isPermissiveConfig(DEFAULT_COPILOT_CONFIG), false)
})

test('Copilot resumes with session/load without journaling the replayed history', async (t) => {
  const f = await fixture(t, { resumeSessionId: 'resumed' })
  assert.ok((await f.rpc()).some((entry) => entry.method === 'session/load' && entry.params.sessionId === 'resumed'))
  assert.ok(!f.events.some((event) => event.type === 'tool.started' || event.type === 'message.completed'))
  assert.ok(f.events.some((event) => event.type === 'session.started' && event.agentSessionId === 'resumed'))
  assert.ok(f.events.some((event) => event.type === 'commands.updated'))
})

test('Copilot interrupts the turn through session/cancel', async (t) => {
  const f = await fixture(t)
  await f.runner.send('fixture:' + JSON.stringify({ steps: [{ permission: { toolCall: { toolCallId: 'x', title: 'rm', kind: 'execute', rawInput: { command: 'rm -rf build' } }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }] } }] }), [], [], [])
  await until(() => f.events.some((event) => event.type === 'permission.requested'))
  await f.runner.interrupt()
  await until(() => f.events.some((event) => event.type === 'turn.completed'))
  const end = f.events.find((event) => event.type === 'turn.completed')!
  assert.equal(end.type === 'turn.completed' && end.stopReason, 'interrupted')
})
