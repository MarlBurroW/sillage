import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { AGENT_CAPABILITIES, DEFAULT_COPILOT_CONFIG, isPermissiveConfig, sillageEventSchema, type CopilotConfig, type McpServer, type SillageEvent } from '@sillage/protocol'
import { describeEdit } from '../src/agents/acp/content.js'
import { CopilotAdapter } from '../src/agents/copilot/adapter.js'
import { CopilotCatalog, forgetProbeSession } from '../src/agents/copilot/catalog.js'
import { COPILOT_SESSION_EVENTS, copilotLaunch, modeOf, skillDirs } from '../src/agents/copilot/launch.js'
import { askUserQuestions } from '../src/agents/copilot/questions.js'
import { CopilotRunner } from '../src/agents/copilot/runner.js'
import { listCopilotSessions } from '../src/agents/copilot/sessions.js'
import { describeCopilotTool, outputOf, shellExit } from '../src/agents/copilot/tools.js'
import { copilotUsage, quotaLimit, readObservedQuotas, refusedLimit, saveObservedQuotas, type CopilotQuota } from '../src/agents/copilot/usage.js'
import type { RunnerContext } from '../src/agents/types.js'
import type { Config } from '../src/config.js'

type Of<T extends SillageEvent['type']> = Extract<SillageEvent, { type: T }>

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 5)) }
}

async function agent(t: TestContext): Promise<{ root: string; binary: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sillage-copilot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'agent.mjs')
  await copyFile(new URL('./fixtures/copilot-agent.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)
  return { root, binary }
}

async function fixture(t: TestContext, changes: Partial<RunnerContext> = {}, config: Partial<CopilotConfig> = {}, options: { start?: boolean } = {}) {
  const { root, binary } = await agent(t)
  const stateDir = join(root, 'state')
  const events: SillageEvent[] = [], raw: unknown[] = [], configs: CopilotConfig[] = [], quotas: [CopilotQuota, boolean][] = [], statuses: string[] = []
  const ctx: RunnerContext = {
    conversationId: `conversation-${randomUUID()}`, cwd: root, binary, config: { ...DEFAULT_COPILOT_CONFIG, ...config }, attachmentsRoot: root, resumeSessionId: null,
    projectOverview: () => 'Shared instructions and memory', maskedInstructionRoots: () => [], memoryDir: () => null, skillRoots: () => [], resolveMcpServers: () => ({ servers: [], failures: [] }),
    emit: (event, native) => { sillageEventSchema.parse(event); events.push(event); raw.push(native) }, setStatus: (status) => { statuses.push(status) }, setAgentSessionId: () => {},
    updateConfig: (next) => { configs.push(next as CopilotConfig) }, openPermissionRequest: () => randomUUID(), closePermissionRequest: () => {}, ...changes,
  }
  const runner = new CopilotRunner(ctx, { stateDir, onQuota: (quota, credits) => { quotas.push([quota, credits]) } })
  t.after(() => runner.stop())
  if (options.start !== false) await runner.start()
  const rpc = async () => (await readFile(join(root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const of = <T extends SillageEvent['type']>(type: T) => events.filter((entry): entry is Of<T> => entry.type === type)
  const turn = async (steps: unknown[], rest: Record<string, unknown> = {}) => {
    const count = of('turn.completed').length
    await runner.send('fixture:' + JSON.stringify({ steps, ...rest }), [], [], [])
    await until(() => of('turn.completed').length > count)
    return of('turn.completed').at(-1)!
  }
  return { root, binary, stateDir, ctx, runner, events, raw, configs, quotas, statuses, rpc, of, turn }
}

const chunk = (text: string, messageId?: string, agentId?: string) => ({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}), ...(agentId ? { _meta: { 'github.com/copilot': { agentId } } } : {}) } })
const announce = (...requests: Record<string, unknown>[]) => ({ event: { type: 'assistant.message', data: { content: '', toolRequests: requests } } })
const PERMISSION_OPTIONS = [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }]

test('Copilot catalog puts Auto first, merges its two entries and reads per-model efforts', async (t) => {
  const { root, binary } = await agent(t)
  const cwd = join(root, 'state', 'catalog')
  const listing = await new CopilotCatalog(async () => binary, cwd).list()
  assert.deepEqual(listing.models.models.map((model) => [model.value, model.hint, model.isDefault]), [['auto', 'auto · 0.9x', true], ['gpt-test', 'gpt-test · 1x', false]])
  assert.deepEqual(listing.models.models[0]!.efforts, [])
  assert.deepEqual(listing.models.models[1]!.efforts.map((effort) => effort.value), ['low', 'medium', 'high'])
  assert.equal(listing.models.models[1]!.defaultEffort, 'medium')
  // `/model` changes state Sillage tracks; `/cwd` and `/session` would leave the conversation's directory or session.
  assert.deepEqual(listing.commands.map((command) => command.name), ['compact', 'usage'])
  // The probe runs in an empty folder of Sillage's own, not in the shared temporary directory.
  assert.equal(JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')).cwd, cwd)
})

test('Copilot catalog probe removes the empty session it leaves in Copilot\'s home, and nothing else', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sillage-copilot-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const empty = '66a0ad48-5f65-44cf-bfec-07c3e6499134', used = '001040c9-cf48-4f04-b850-f7c518d45903'
  for (const id of [empty, used]) {
    await mkdir(join(home, 'session-state', id, 'checkpoints'), { recursive: true })
    await writeFile(join(home, 'session-state', id, 'workspace.yaml'), 'cwd: /p\n')
  }
  await writeFile(join(home, 'session-state', used, 'events.jsonl'), '{}\n')
  forgetProbeSession(empty, home)
  // A session that received a prompt has an event log: it is someone's conversation.
  forgetProbeSession(used, home)
  forgetProbeSession('../../etc', home)
  forgetProbeSession(undefined, home)
  assert.equal(existsSync(join(home, 'session-state', empty)), false)
  assert.equal(existsSync(join(home, 'session-state', used, 'events.jsonl')), true)
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

test('Copilot tools take their native name when announced, and their shape otherwise', () => {
  const native = (name: string) => ({ name, mcpServer: null, mcpTool: null })
  // Named by `assistant.message`, with Claude-style arguments.
  assert.deepEqual(describeCopilotTool({ kind: 'read', title: 'Viewing /p/a.txt', rawInput: { path: '/p/a.txt', view_range: [5, 9] } }, native('view')), { name: 'Read', input: { file_path: '/p/a.txt', offset: 5, limit: 5 }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'read', title: 'Viewing /p/a.txt', rawInput: { path: '/p/a.txt', view_range: [5, -1] } }, native('view')).input, { file_path: '/p/a.txt', offset: 5 })
  assert.deepEqual(describeCopilotTool({ kind: 'edit', title: 'Creating /p/new.txt', rawInput: { path: '/p/new.txt', file_text: 'x\n' } }, native('create')), { name: 'Write', input: { file_path: '/p/new.txt', content: 'x\n' }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'edit', title: 'Editing /p/a.txt', rawInput: { path: '/p/a.txt', old_str: 'a', new_str: 'b' } }, native('edit')), { name: 'Edit', input: { file_path: '/p/a.txt', old_string: 'a', new_string: 'b' }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'execute', title: 'npm test', rawInput: { command: 'npm test', description: 'Run the tests', mode: 'async', shellId: 'tests' } }, native('bash')), { name: 'Bash', input: { command: 'npm test', description: 'Run the tests', run_in_background: true }, title: 'Run the tests' })
  assert.deepEqual(describeCopilotTool({ kind: 'other', title: 'Read the note', rawInput: { name: 'scout', description: 'Read the note', agent_type: 'explore', mode: 'background', prompt: 'Read it.' } }, native('task')), { name: 'Agent', input: { description: 'Read the note', prompt: 'Read it.', subagent_type: 'explore', name: 'scout', run_in_background: true }, title: 'Read the note' })
  assert.deepEqual(describeCopilotTool({ kind: 'other', title: 'Insert todos', rawInput: { description: 'Insert todos', query: 'INSERT …' } }, native('sql')), { name: 'sql', input: { description: 'Insert todos', query: 'INSERT …' }, title: 'Insert todos' })
  // An MCP call is its server and tool, never its title.
  assert.deepEqual(describeCopilotTool({ kind: 'other', title: 'sillage-create_card', rawInput: { title: 'Card' } }, { name: 'sillage-create_card', mcpServer: 'sillage', mcpTool: 'create_card' }), { name: 'sillage/create_card', input: { title: 'Card' }, title: null })
  // Tools without a canonical name keep their own, with Copilot's title as the label.
  assert.deepEqual(describeCopilotTool({ kind: 'read', title: 'Reading shell output', rawInput: { shellId: 'slow', delay: 0 } }, native('read_bash')), { name: 'read_bash', input: { shellId: 'slow', delay: 0 }, title: 'Reading shell output' })

  // Unannounced (replayed history): the shape of the input decides.
  assert.deepEqual(describeCopilotTool({ kind: 'read', title: 'Viewing /p/a.txt', rawInput: { path: '/p/a.txt' } }), { name: 'Read', input: { file_path: '/p/a.txt' }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'execute', title: 'ls -la', rawInput: { command: 'ls -la', description: 'List directory contents' } }), { name: 'Bash', input: { command: 'ls -la', description: 'List directory contents' }, title: 'List directory contents' })
  assert.deepEqual(describeCopilotTool({ kind: 'edit', title: 'apply_patch', rawInput: '*** Begin Patch\n*** Update File: /p/a.txt\n@@\n-a\n+b\n*** End Patch\n' }).input.file_path, '/p/a.txt')
  assert.equal(describeCopilotTool({ kind: 'edit', title: 'apply_patch', rawInput: '*** Begin Patch\n*** Add File: /p/new.txt\n+x\n*** End Patch\n' }).name, 'Write')
  assert.equal(describeCopilotTool({ kind: 'edit', title: 'Create file', rawInput: { fileName: '/p/new.txt', diff: '--- a/dev/null\n+++ b/p/new.txt\n' } }).name, 'Write')
  assert.equal(describeCopilotTool({ kind: 'edit', title: 'Creating /p/new.txt', rawInput: { path: '/p/new.txt', file_text: 'x' } }).name, 'Write')
  assert.deepEqual(describeCopilotTool({ kind: 'read', title: "Searching for 'bye'", rawInput: { pattern: 'bye', paths: '/p', output_mode: 'content', '-n': true } }), { name: 'Grep', input: { pattern: 'bye', output_mode: 'content', '-n': true, path: '/p' }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'read', title: 'Finding files matching *.txt', rawInput: { pattern: '*.txt', paths: '/p' } }), { name: 'Glob', input: { pattern: '*.txt', path: '/p' }, title: null })
  assert.deepEqual(describeCopilotTool({ kind: 'fetch', title: 'Fetching https://example.com', rawInput: { url: 'https://example.com' } }), { name: 'WebFetch', input: { url: 'https://example.com' }, title: null })
  assert.equal(describeCopilotTool({ kind: 'other', title: 'Read the note', rawInput: { name: 'scout', agent_type: 'explore', prompt: 'Read it.' } }).name, 'Agent')
  assert.equal(describeCopilotTool({ kind: 'other', title: 'ask_user', rawInput: { message: 'Which?', requestedSchema: {} } }).name, 'ask_user')
  assert.deepEqual(describeCopilotTool({ kind: 'other', title: 'probe-echo', rawInput: { message: 'ping' } }), { name: 'probe-echo', input: { message: 'ping' }, title: null })

  // A shell's status line is Copilot's own; the exit code says the same.
  const closed = { rawOutput: { content: 'oops\n<shellId: 1 completed with exit code 3>', contents: [{ type: 'shell_exit', shellId: '1', exitCode: 3 }] } }
  assert.equal(outputOf(closed), 'oops\n')
  assert.deepEqual(shellExit(closed), { shellId: '1', exitCode: 3 })
  assert.equal(outputOf({ rawOutput: { content: 'Output:\ndone\n<detached command with shellId: det completed with exit code 0>' } }), 'Output:\ndone\n')
  // A failed call says why in `message`.
  assert.equal(outputOf({ status: 'failed', rawOutput: { message: 'Path does not exist', code: 'failure' } }), 'Path does not exist')
})

test('Copilot announces forms and subscribes to the session events it relies on', async (t) => {
  const f = await fixture(t)
  const initialize = (await f.rpc()).find((entry) => entry.method === 'initialize')
  assert.deepEqual(initialize.params.clientCapabilities.elicitation, { form: {} })
  assert.deepEqual(initialize.params.clientCapabilities._meta['github.com/copilot'].events, [...COPILOT_SESSION_EVENTS])
  assert.equal(initialize.params.clientInfo.name.length > 0, true)
  // Copilot repeats the command list at startup: one journal entry.
  await until(() => f.of('commands.updated').length > 0)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(f.of('commands.updated').length, 1)
  assert.deepEqual(f.of('commands.updated')[0]!.commands.map((command) => command.name), ['compact', 'usage'])
})

test('Copilot streams thoughts, tools, a permissioned edit and its diff', async (t) => {
  const f = await fixture(t)
  const file = join(f.root, 'a.txt')
  const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n`
  const answered = f.turn([
    { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking' }, messageId: 'think-1' } },
    announce({ toolCallId: 'read', name: 'view', arguments: { path: file } }),
    { update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: `Viewing ${file}`, kind: 'read', status: 'pending', rawInput: { path: file }, locations: [{ path: file }] } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: { content: 'a\n', detailedContent: 'diff' } } },
    announce({ toolCallId: 'edit', name: 'apply_patch', arguments: patch }),
    { update: { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'apply_patch', kind: 'edit', status: 'pending', rawInput: patch } },
    { permission: { toolCall: { toolCallId: 'edit', title: 'Edit file', kind: 'edit', status: 'pending', rawInput: { fileName: file, diff: '-a\n+b\n' }, locations: [{ path: file }] }, options: PERMISSION_OPTIONS } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [{ type: 'diff', path: file, oldText: 'a\n', newText: 'b\n' }], rawOutput: { content: `Modified 1 file(s): ${file}` } } },
    { update: { sessionUpdate: 'usage_update', used: 100, size: 1000 } },
    chunk('Done', 'reply-1'),
  ])
  await until(() => f.of('permission.requested').length > 0)
  const request = f.of('permission.requested')[0]!
  // The row's own description, not the diff the request carries instead.
  assert.equal(request.toolName, 'Edit')
  assert.deepEqual(request.input, { file_path: file, patch })
  f.runner.resolvePermission(request.requestId, { decision: 'allowed', scope: 'session', decidedBy: null })
  await answered
  assert.deepEqual(f.of('tool.started').map((event) => event.name), ['Read', 'Edit'])
  assert.ok(f.of('tool.completed').some((event) => event.toolCallId === 'read' && event.output === 'a\n'))
  // Output that only arrives with the closing frame is not also sent as a delta.
  assert.equal(f.of('tool.output_delta').length, 0)
  assert.deepEqual((await f.rpc()).filter((entry) => 'answer' in entry).map((entry) => entry.answer), [{ outcome: { outcome: 'selected', optionId: 'allow_always' } }])
  assert.ok(f.of('file.edited').some((event) => event.path === 'a.txt' && event.action === 'modified'))
  const completed = f.events.findIndex((event) => event.type === 'tool.completed' && event.toolCallId === 'edit')
  assert.match(describeEdit(f.raw[completed], f.root, 'a.txt').patch, /\+b/)
  assert.ok(f.of('thinking.delta').some((event) => event.text === 'Checking'))
  assert.ok(f.of('usage.updated').some((event) => event.context?.usedTokens === 100))
  assert.deepEqual(f.of('message.completed').map((event) => event.blocks[0]), [{ type: 'thinking', text: 'Checking' }, { type: 'text', text: 'Done' }])
  // Instructions live under Sillage's own state folder, never in the shared temporary directory.
  const launch = JSON.parse(await readFile(join(f.root, 'launch.json'), 'utf8'))
  assert.equal(launch.instructions, join(f.stateDir, 'instructions', f.ctx.conversationId))
  assert.match(await readFile(join(launch.instructions, '.github', 'instructions', 'sillage.instructions.md'), 'utf8'), /^---\napplyTo: "\*\*"\n---\nShared instructions and memory/)
  await f.runner.stop()
  assert.equal(existsSync(launch.instructions), false)
})

test('Copilot counts the tokens of each turn, not of the session so far', async (t) => {
  const f = await fixture(t)
  const first = await f.turn([chunk('One', 'r1')], { usage: { inputTokens: 1000, outputTokens: 30, thoughtTokens: 12, cachedReadTokens: 400, cachedWriteTokens: 100 } })
  // Cache reads and writes are inside Copilot's input, reasoning inside its output.
  assert.deepEqual([first.inputTokens, first.outputTokens, first.cacheReadTokens, first.cacheCreationTokens], [500, 30, 400, 100])
  const second = await f.turn([chunk('Two', 'r2')], { usage: { inputTokens: 200, outputTokens: 5, cachedReadTokens: 50 } })
  assert.deepEqual([second.inputTokens, second.outputTokens, second.cacheReadTokens, second.cacheCreationTokens], [150, 5, 50, 0])
  // Model calls reported as events are exact, a sub-agent's included.
  const third = await f.turn([
    { event: { type: 'assistant.usage', data: { model: 'gpt-test', inputTokens: 300, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 } } },
    { event: { type: 'assistant.usage', data: { model: 'gpt-test', inputTokens: 80, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } }, agentId: 'agent-1' },
    chunk('Three', 'r3'),
  ], { usage: { inputTokens: 380, outputTokens: 24, cachedReadTokens: 100 } })
  assert.deepEqual([third.inputTokens, third.outputTokens, third.cacheReadTokens], [280, 24, 100])
})

test('Copilot charges a turn to the model Auto routed it to, apart from other models, with its AI credits', async (t) => {
  const f = await fixture(t)
  const call = (model: string, inputTokens: number, outputTokens: number, nanoAiu?: number) => ({ model, isAuto: true, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, ...(nanoAiu === undefined ? {} : { copilotUsage: { totalNanoAiu: nanoAiu } }) })
  const routed = await f.turn([
    { event: { type: 'assistant.usage', data: call('mai-code-2-flash', 17445, 5, 174_700_000) } },
    // The sub-agent picked its own model.
    { event: { type: 'assistant.usage', data: call('gpt-6-luna', 900, 40, 27_406_000) }, agentId: 'agent-1' },
    { event: { type: 'assistant.usage', data: call('mai-code-2-flash', 706, 69, 25_000_000) } },
    chunk('Done', 'r1'),
  ], { usage: { inputTokens: 19051, outputTokens: 114 } })
  assert.deepEqual([routed.model, routed.inputTokens, routed.outputTokens, routed.aiCredits], ['mai-code-2-flash', 18151, 74, 0.1997])
  const consumed = f.of('usage.consumed')
  assert.deepEqual(consumed.map((event) => [event.model, event.inputTokens, event.outputTokens, event.aiCredits]), [['gpt-6-luna', 900, 40, 0.027406]])
  // Charged before the turn closes, so that it belongs to it.
  assert.ok(f.events.indexOf(consumed[0]!) < f.events.indexOf(routed))
  // A plan without AI credits says nothing of them, and a turn without events keeps its totals.
  const plain = await f.turn([{ event: { type: 'assistant.usage', data: call('gpt-test', 10, 1) } }, chunk('Two', 'r2')])
  assert.deepEqual([plain.model, plain.aiCredits], ['gpt-test', undefined])
  const silent = await f.turn([chunk('Three', 'r3')], { usage: { inputTokens: 100, outputTokens: 2 } })
  assert.deepEqual([silent.model, silent.inputTokens], [undefined, 100])
  assert.equal(f.of('usage.consumed').length, 1)
})

test('Copilot applies model, effort, permissions and mode as session options, live', async (t) => {
  const f = await fixture(t, {}, { model: 'gpt-test', reasoningEffort: 'high', mode: 'plan', allowAll: 'auto' })
  const sets = async () => (await f.rpc()).filter((entry) => entry.method === 'session/set_config_option').map((entry) => [entry.params.configId, entry.params.value])
  // The effort option appears only once the model that has one is selected; the mode comes last.
  assert.deepEqual(await sets(), [['model', 'gpt-test'], ['reasoning_effort', 'high'], ['allow_all', 'auto'], ['mode', 'https://agentclientprotocol.com/protocol/session-modes#plan']])
  assert.equal(await f.runner.applyConfig({ ...f.ctx.config as CopilotConfig, model: 'gpt-test', reasoningEffort: 'low', mode: 'agent', allowAll: 'off' }), true)
  assert.equal(f.configs.at(-1)?.reasoningEffort, 'low')
  assert.equal(f.configs.at(-1)?.mode, 'agent')
  // Autopilot turns allow-all on by itself, and leaving it turns it back off: the settings follow Copilot.
  assert.equal(await f.runner.applyConfig({ ...f.runner.appliedConfig as CopilotConfig, mode: 'autopilot' }), true)
  assert.deepEqual([f.configs.at(-1)?.mode, f.configs.at(-1)?.allowAll], ['autopilot', 'on'])
  assert.equal((await sets()).at(-1)![0], 'mode')
  assert.equal(await f.runner.applyConfig({ ...f.runner.appliedConfig as CopilotConfig, mode: 'agent' }), true)
  assert.deepEqual([f.configs.at(-1)?.mode, f.configs.at(-1)?.allowAll], ['agent', 'off'])
  // The Auto profile is read at launch: changing it needs a restart.
  assert.equal(await f.runner.applyConfig({ ...f.ctx.config as CopilotConfig, model: 'auto', autoTier: 'balance' }), false)
  assert.equal(modeOf('https://agentclientprotocol.com/protocol/session-modes#autopilot'), 'autopilot')
  assert.equal(isPermissiveConfig({ ...DEFAULT_COPILOT_CONFIG, mode: 'autopilot' }), true)
  assert.equal(isPermissiveConfig(DEFAULT_COPILOT_CONFIG), false)
})

test('Copilot nests a sub-agent under the call that spawned it', async (t) => {
  const f = await fixture(t)
  const child = { 'github.com/copilot': { agentId: 'agent-1' } }
  await f.turn([
    announce({ toolCallId: 'task', name: 'task', arguments: {} }),
    { update: { sessionUpdate: 'tool_call', toolCallId: 'task', title: 'Read the note', kind: 'other', status: 'pending', rawInput: { name: 'scout', description: 'Read the note', agent_type: 'explore', mode: 'sync', prompt: 'Read it.' } } },
    // The only link between a sub-agent and its spawning call.
    { event: { type: 'assistant.turn_start', data: { turnId: '0', parentToolCallId: 'task' } }, agentId: 'agent-1' },
    { ...announce({ toolCallId: 'view', name: 'view', arguments: {} }), agentId: 'agent-1' },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'view', title: 'Viewing /p/note.txt', kind: 'read', status: 'pending', rawInput: { path: '/p/note.txt' }, _meta: child } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'view', status: 'completed', rawOutput: { content: 'hello\n' }, _meta: child } },
    { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'sub thinking' }, messageId: 't1', _meta: child } },
    chunk('The note says hello.', 'm1', 'agent-1'),
    // The main thread speaks while the sub-agent still does: two streams, not one.
    chunk('Waiting for the scout.', 'main-1'),
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'task', status: 'completed', rawOutput: { content: 'The note says hello.' } } },
    chunk(' Done.', 'main-1'),
  ])
  assert.deepEqual(f.of('tool.started').map((event) => [event.name, event.parentToolCallId]), [['Agent', null], ['Read', 'task']])
  assert.deepEqual(f.of('message.completed').map((event) => [event.blocks[0]!.type === 'text' || event.blocks[0]!.type === 'thinking' ? event.blocks[0]!.text : '', event.parentToolCallId]), [
    ['sub thinking', 'task'], ['The note says hello.', 'task'], ['Waiting for the scout. Done.', null],
  ])

  // An agent left in the background names itself when its call returns, and keeps talking after it.
  await f.turn([
    { update: { sessionUpdate: 'tool_call', toolCallId: 'bg', title: 'Background look', kind: 'other', status: 'pending', rawInput: { name: 'bgscout', description: 'Background look', agent_type: 'explore', mode: 'background', prompt: 'Wait.' } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'completed', rawOutput: { content: 'Agent started in background with agent_id: agent-2. You\'ll be notified when it completes.' } } },
    chunk('Background agent result.', 'm2', 'agent-2'),
  ])
  assert.deepEqual(f.of('message.completed').at(-1)!.parentToolCallId, 'bg')
})

test('Copilot asks through a question card, and hides the ask_user call', async (t) => {
  const f = await fixture(t)
  const schema = { type: 'object', properties: { flavor: { type: 'string', title: 'Flavor', enum: ['vanilla', 'mint'], enumNames: ['Vanilla', 'Fresh mint'] } } }
  const asked = f.turn([
    announce({ toolCallId: 'ask', name: 'ask_user', arguments: {} }),
    { update: { sessionUpdate: 'tool_call', toolCallId: 'ask', title: 'ask_user', kind: 'other', status: 'pending', rawInput: { message: 'Which flavor?', requestedSchema: schema } } },
    { elicit: { message: 'Which flavor?', requestedSchema: schema, toolCallId: 'ask' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'ask', status: 'completed', rawOutput: { content: 'User responded: flavor=mint' } } },
    chunk('Mint it is.', 'r1'),
  ])
  await until(() => f.of('question.requested').length > 0)
  const question = f.of('question.requested')[0]!
  assert.deepEqual(question.questions, [{ id: 'flavor', header: 'Flavor', question: 'Which flavor?', multiSelect: false, allowOther: true, secret: false, options: [{ label: 'Vanilla', description: '', preview: null }, { label: 'Fresh mint', description: '', preview: null }] }])
  assert.equal(f.statuses.at(-1), 'awaiting_input')
  f.runner.answerQuestion(question.requestId, { status: 'answered', answers: { flavor: ['Fresh mint'] }, decidedBy: null })
  await asked
  // The label the user picked goes back as the value Copilot listed.
  assert.deepEqual((await f.rpc()).find((entry) => 'elicited' in entry).elicited, { action: 'accept', content: { flavor: 'mint' } })
  assert.equal(f.of('tool.started').length, 0)

  // Anything but choices is a form.
  const notes = { type: 'object', properties: { notes: { type: 'string', title: 'Notes' } } }
  const formed = f.turn([{ elicit: { message: 'Any notes?', requestedSchema: notes } }])
  await until(() => f.of('elicitation.requested').length > 0)
  const form = f.of('elicitation.requested')[0]!
  assert.equal(form.message, 'Any notes?')
  assert.deepEqual(form.fields.map((field) => [field.name, field.kind]), [['notes', 'text']])
  f.runner.resolveElicitation(form.requestId, { action: 'decline', content: {}, decidedBy: null })
  await formed
  assert.deepEqual((await f.rpc()).filter((entry) => 'elicited' in entry).at(-1).elicited, { action: 'decline' })

  // Several choice fields make several questions; a free answer passes through as typed.
  const many = askUserQuestions('Pick both.', { properties: { size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] }, toppings: { type: 'array', title: 'Toppings', items: { enum: ['nuts', 'syrup'] } } } })!
  assert.deepEqual(many.questions.map((entry) => [entry.id, entry.question, entry.multiSelect]), [['size', 'Pick both.\n\nsize', false], ['toppings', 'Toppings', true]])
  assert.deepEqual(many.content({ size: ['Large'], toppings: ['nuts', 'sprinkles'] }), { size: 'l', toppings: ['nuts', 'sprinkles'] })
  assert.equal(askUserQuestions('Mixed.', { properties: { ok: { type: 'boolean' } } }), null)
})

test('Copilot names MCP calls after their server and tool, and follows server health', async (t) => {
  const probe: McpServer = { id: 'probe-id', name: 'probe', enabled: true, transport: { type: 'stdio', command: 'node', args: [], env: {} }, projectId: null, createdAt: 0, updatedAt: 0 }
  const f = await fixture(t, { resolveMcpServers: () => ({ servers: [probe], failures: [] }) })
  // Announced as pending by the session request itself.
  assert.deepEqual(f.of('mcp.updated').at(-1)!.servers.map((server) => [server.name, server.state, server.external]), [['probe', 'pending', false]])
  await f.turn([
    { event: { type: 'session.mcp_server_status_changed', data: { serverName: 'probe', status: 'connected' } } },
    { event: { type: 'session.mcp_servers_loaded', data: { servers: [{ name: 'probe', status: 'connected' }, { name: 'github-mcp-server', status: 'failed', error: 'offline' }] } } },
    // Sent again with every prompt: nothing changed, nothing journaled.
    { event: { type: 'session.mcp_servers_loaded', data: { servers: [{ name: 'probe', status: 'connected' }, { name: 'github-mcp-server', status: 'failed', error: 'offline' }] } } },
    announce({ toolCallId: 'echo', name: 'probe-echo', arguments: { message: 'ping' }, mcpServerName: 'probe', mcpToolName: 'echo' }),
    { update: { sessionUpdate: 'tool_call', toolCallId: 'echo', title: 'probe-echo', kind: 'other', status: 'pending', rawInput: { message: 'ping' } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'echo', status: 'completed', rawOutput: { content: 'echo: ping' } } },
  ])
  assert.deepEqual(f.of('tool.started').map((event) => event.name), ['probe/echo'])
  const states = f.of('mcp.updated').map((event) => event.servers.map((server) => `${server.name}:${server.state}:${server.tools.join('+')}${server.external ? ':external' : ''}`).join(' '))
  assert.deepEqual(states.slice(-3), ['probe:connected:', 'probe:connected: github-mcp-server:failed::external', 'probe:connected:echo github-mcp-server:failed::external'])
  assert.equal(f.of('mcp.updated').at(-1)!.servers[1]!.error, 'offline')
})

/** Copilot's expansion of MCP config files as probed on 1.0.116: `$NAME`, `${NAME}`, `${NAME:-default}`, one pass. */
function copilotExpand(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (match, braced?: string, fallback?: string, bare?: string) => {
    const name = braced ?? bare!
    if (env[name]) return env[name]
    return fallback ?? match
  })
}

test('Copilot passes Sillage MCP servers where the user\'s own Copilot servers cannot shadow them, secrets intact', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sillage-copilot-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  // The user added a server of the same name to their terminal Copilot, as `copilot mcp add sillage` would.
  await writeFile(join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: { probe: { type: 'local', command: '/nonexistent/user-probe' }, mine: { type: 'local', command: '/usr/bin/mine' } } }))
  const secret = 'pa$$w0rd${HOME}$1'
  const probe: McpServer = { id: 'probe-id', name: 'probe', enabled: true, transport: { type: 'stdio', command: 'node', args: ['server.mjs', '$HOME'], env: { SECRET: secret } }, projectId: null, createdAt: 0, updatedAt: 0 }
  const remote: McpServer = { id: 'remote-id', name: 'remote', enabled: true, transport: { type: 'http', url: 'https://mcp.example/x?k=$HOME', headers: { Authorization: 'Bearer $TOKEN' } }, projectId: null, createdAt: 0, updatedAt: 0 }
  const f = await fixture(t, { processEnv: { COPILOT_HOME: home }, resolveMcpServers: () => ({ servers: [probe, remote], failures: [] }) })
  const opened = (await f.rpc()).find((entry) => entry.method === 'session/new')
  assert.deepEqual(opened.params.mcpServers, [])
  const launched = JSON.parse(await readFile(join(f.root, 'launch.json'), 'utf8')).args as string[]
  const file = launched[launched.indexOf('--additional-mcp-config') + 1]!.slice(1)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const winners = JSON.parse(await readFile(join(f.root, 'mcp.json'), 'utf8'))
  assert.deepEqual(Object.fromEntries(Object.entries(winners).map(([name, server]) => [name, (server as { source: string }).source])), { probe: 'additional', mine: 'user', remote: 'additional' })
  // Copilot expands variables in that file, and nothing but an unset variable's default escapes a dollar sign.
  const env = { HOME: '/home/someone', TOKEN: 'server-token', '1': 'one' }
  assert.equal(copilotExpand(winners.probe.env.SECRET, env), secret)
  assert.deepEqual(winners.probe.args.map((arg: string) => copilotExpand(arg, env)), ['server.mjs', '$HOME'])
  assert.equal(copilotExpand(winners.remote.url, env), 'https://mcp.example/x?k=$HOME')
  assert.equal(copilotExpand(winners.remote.headers.Authorization, env), 'Bearer $TOKEN')
  assert.deepEqual(f.of('mcp.updated').at(-1)!.servers.map((server) => [server.name, server.state, server.external]), [['probe', 'pending', false], ['remote', 'pending', false], ['mine', 'pending', true]])
  await f.runner.stop()
  assert.equal(existsSync(file), false)
})

test('Copilot reports errors, retries and refusals as what they are, not as reply text', async (t) => {
  const f = await fixture(t)
  const failed = await f.turn([
    { event: { type: 'assistant.turn_retry', data: { turnId: '0', model: 'gpt-test', reason: 'rate_limit' } } },
    { event: { type: 'session.info', data: { infoType: 'model_retry', message: 'Request failed due to a transient API error. Retrying...' } } },
    chunk('Info: Request failed due to a transient API error. Retrying...'),
    { event: { type: 'session.error', data: { errorType: 'rate_limit', message: 'You\'ve hit your rate limit.', statusCode: 429 } } },
    chunk('Error: You\'ve hit your rate limit.'),
  ], { failed: true })
  assert.equal(failed.stopReason, 'failed')
  assert.deepEqual(f.of('error').map((event) => [event.code, event.message, event.recoverable]), [['rate_limit_exceeded', 'You\'ve hit your rate limit.', true]])
  assert.deepEqual(f.of('agent.notice').map((event) => [event.id, event.code]), [['api-retry', 'copilot_retry']])
  // The refusal is what lets Sillage offer to resume later; a rate limit's reset is not the plan's.
  assert.deepEqual(f.of('usage.updated').at(-1)!.rateLimit, { type: 'rate_limit', status: 'rejected', utilization: null, resetsAt: null })
  assert.equal(f.of('message.completed').length, 0)

  // A refused permission ends Copilot's whole turn.
  const denied = f.turn([
    { update: { sessionUpdate: 'tool_call', toolCallId: 'new', title: 'Creating /p/new.txt', kind: 'edit', status: 'pending', rawInput: { path: '/p/new.txt', file_text: 'x' } } },
    { permission: { toolCall: { toolCallId: 'new', title: 'Create file', kind: 'edit', status: 'pending', rawInput: { fileName: '/p/new.txt', diff: '+x' } }, options: PERMISSION_OPTIONS } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'new', status: 'failed', rawOutput: { message: 'The user rejected this tool call.', code: 'rejected' } } },
    { event: { type: 'session.info', data: { infoType: 'cancellation', message: 'Operation cancelled by user' } } },
    chunk('Info: Operation cancelled by user'),
  ])
  await until(() => f.of('permission.requested').length > 0)
  const request = f.of('permission.requested')[0]!
  assert.deepEqual([request.toolName, request.input], ['Write', { file_path: '/p/new.txt', content: 'x' }])
  f.runner.resolvePermission(request.requestId, { decision: 'denied', scope: 'once', decidedBy: null })
  assert.equal((await denied).stopReason, 'permission_denied')
  assert.deepEqual(f.of('tool.completed').at(-1), { type: 'tool.completed', toolCallId: 'new', output: 'The user rejected this tool call.', isError: true, durationMs: f.of('tool.completed').at(-1)!.durationMs })
  assert.equal(f.of('file.edited').length, 0)

  // Slash-command output has no message ID either, and is the reply.
  await f.turn([chunk('Session Usage\n\nRequests: 0 Premium')])
  assert.deepEqual(f.of('message.completed').at(-1)!.blocks, [{ type: 'text', text: 'Session Usage\n\nRequests: 0 Premium' }])
  // Other information and warnings stay visible, as notices.
  await f.turn([
    { event: { type: 'session.warning', data: { warningType: 'policy', message: 'Third-party MCP servers are disabled by your organization.' } } },
    chunk('Warning: Third-party MCP servers are disabled by your organization.'),
    { event: { type: 'session.info', data: { infoType: 'notification', message: 'Plan: 75% used.' } } },
    chunk('Info: Plan: 75% used.'),
    // Sent with every real session and never written into the reply: Copilot keeps it to itself.
    { event: { type: 'session.info', data: { infoType: 'search_subagent_exploration_guidance', message: 'Search-subagent exploration guidance: disabled.' } } },
  ])
  assert.equal(f.of('agent.notice').length, 3)
  assert.deepEqual(f.of('agent.notice').slice(-2).map((event) => [event.code, event.level, event.message]), [['copilot_warning_policy', 'warning', 'Third-party MCP servers are disabled by your organization.'], ['copilot_info_notification', 'info', 'Plan: 75% used.']])
})

test('Copilot shells: exit codes, background work and the turn Copilot opens when it reports back', async (t) => {
  const f = await fixture(t)
  const exit = (shellId: string, exitCode: number, output: string) => ({ content: `${output}<shellId: ${shellId} completed with exit code ${exitCode}>`, contents: [{ type: 'shell_exit', shellId, exitCode }] })
  await f.turn([
    announce({ toolCallId: 'fail', name: 'bash', arguments: {} }),
    { update: { sessionUpdate: 'tool_call', toolCallId: 'fail', title: 'exit 3', kind: 'execute', status: 'pending', rawInput: { command: 'echo oops; exit 3', description: 'Fail on purpose' } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'fail', content: [{ type: 'content', content: { type: 'text', text: 'oops\n' } }] } },
    // Copilot closes a failing command as completed.
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'fail', status: 'completed', rawOutput: exit('1', 3, 'oops\n') } },
    announce({ toolCallId: 'bg', name: 'bash', arguments: {} }),
    { update: { sessionUpdate: 'tool_call', toolCallId: 'bg', title: 'sleep 4', kind: 'execute', status: 'pending', rawInput: { command: 'sleep 4; echo done', description: 'Detached job', mode: 'async', detach: true, shellId: 'det' } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'completed', rawOutput: { content: '<command started in detached background with shellId: det>', structuredContent: { shellId: 'det' } } } },
    chunk('Left it running.', 'r1'),
  ], {
    usage: { inputTokens: 100, outputTokens: 10 },
    // The prompt is answered; the shell finishes later and Copilot reads it by itself.
    after: [
      { wait: 20 },
      announce({ toolCallId: 'read', name: 'read_bash', arguments: { shellId: 'det', delay: 0 } }),
      { update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Reading shell output', kind: 'read', status: 'pending', rawInput: { shellId: 'det', delay: 0 } } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: { content: 'Output:\ndone\n<detached command with shellId: det completed with exit code 0>', contents: [{ type: 'shell_exit', shellId: 'det', exitCode: 0 }] } } },
      { event: { type: 'assistant.usage', data: { model: 'gpt-test', inputTokens: 40, outputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 0 } } },
      chunk('The job finished.', 'r2'),
    ],
  })
  const failed = f.of('tool.completed').find((event) => event.toolCallId === 'fail')!
  assert.deepEqual([failed.isError, failed.output], [true, 'oops\n'])
  assert.deepEqual(f.of('tool.output_delta').map((event) => event.chunk), ['oops\n'])
  assert.deepEqual(f.of('background.updated')[0]!.tasks, [{ id: 'bg', kind: 'shell', description: 'Detached job' }])
  // Published before the turn closes: a shell announced later would look interrupted.
  assert.ok(f.events.findIndex((event) => event.type === 'background.updated') < f.events.findIndex((event) => event.type === 'turn.completed'))

  await until(() => f.of('turn.completed').length === 2)
  const wake = f.of('turn.completed')[1]!
  assert.deepEqual([wake.stopReason, wake.inputTokens, wake.outputTokens, wake.cacheReadTokens], ['completed', 30, 3, 10])
  assert.equal(f.of('turn.started').length, 2)
  assert.deepEqual(f.of('background.updated').at(-1)!.tasks, [])
  assert.deepEqual(f.of('tool.started').at(-1)!.name, 'read_bash')
  assert.equal(f.of('tool.completed').at(-1)!.output, 'Output:\ndone\n')
  assert.equal(f.statuses.at(-1), 'idle')
  // The next prompt counts its own tokens only.
  const next = await f.turn([chunk('Next', 'r3')], { usage: { inputTokens: 60, outputTokens: 6 } })
  assert.deepEqual([next.inputTokens, next.outputTokens], [60, 6])
})

test('Copilot compacts through its slash command, outside any turn', async (t) => {
  const f = await fixture(t)
  await until(() => f.of('commands.updated').length > 0)
  assert.equal(AGENT_CAPABILITIES.copilot.compact, true)
  assert.equal(await f.runner.compact(), true)
  await until(() => f.of('context.compacted').length > 0)
  assert.deepEqual(f.of('context.compacted'), [{ type: 'context.compacted', trigger: 'manual', preTokens: 900, postTokens: 300 }])
  assert.equal(f.of('context.compaction_started').length, 1)
  assert.equal((await f.rpc()).filter((entry) => entry.method === 'session/prompt').at(-1).params.prompt[0].text, '/compact')
  // No turn, and Copilot's own confirmation line is not a reply.
  assert.equal(f.of('turn.started').length, 0)
  assert.equal(f.events.some((event) => event.type === 'message.delta' || event.type === 'message.completed'), false)
  // A message sent meanwhile waits for the compaction instead of cancelling it.
  const turn = await f.turn([chunk('After', 'r1')], { usage: { inputTokens: 10, outputTokens: 1 } })
  assert.equal(turn.inputTokens, 10)
})

test('Copilot says how to sign in when the machine has no Copilot login', async (t) => {
  const f = await fixture(t, { processEnv: { COPILOT_FIXTURE_SIGNED_OUT: '1' } }, {}, { start: false })
  await assert.rejects(f.runner.start(), /not signed in on this machine\. Run `copilot login`/)
  // The model list of a draft fails the same way, with the same advice.
  process.env.COPILOT_FIXTURE_SIGNED_OUT = '1'
  t.after(() => { delete process.env.COPILOT_FIXTURE_SIGNED_OUT })
  await assert.rejects(new CopilotCatalog(async () => f.binary, join(f.root, 'catalog')).list(), /not signed in on this machine/)
})

test('Copilot resumes with session/load without journaling the replayed history', async (t) => {
  const f = await fixture(t, { resumeSessionId: 'resumed' })
  assert.ok((await f.rpc()).some((entry) => entry.method === 'session/load' && entry.params.sessionId === 'resumed'))
  assert.ok(!f.events.some((event) => event.type === 'tool.started' || event.type === 'message.completed' || event.type === 'turn.started'))
  assert.ok(f.of('session.started').some((event) => event.agentSessionId === 'resumed'))
  assert.equal(f.of('commands.updated').length, 1)
})

test('Copilot adopts a native session by journaling the history session/load replays', async (t) => {
  const f = await fixture(t, { resumeSessionId: '11111111-1111-4111-8111-111111111111' }, {}, { start: false })
  await f.runner.importHistory()
  assert.deepEqual(f.of('message.completed').map((event) => [event.role, event.blocks[0]!.type === 'text' ? event.blocks[0]!.text : '', event.parentToolCallId]), [
    ['user', 'Earlier question', null], ['assistant', 'Earlier answer', null],
    ['user', 'Second question', null], ['assistant', 'The note says hello.', 'old-task'], ['assistant', 'Second answer', null],
  ])
  assert.deepEqual(f.of('tool.started').map((event) => [event.name, event.parentToolCallId]), [['Bash', null], ['Agent', null], ['Read', 'old-task']])
  assert.equal(f.of('tool.completed')[0]!.output, 'a.txt\n')
  assert.deepEqual(f.of('turn.completed').map((event) => event.stopReason), ['completed', 'completed'])
  assert.equal(f.of('turn.started').length, 2)
  // History, not work: the conversation never shows as running, and nothing is asked of the session.
  assert.ok(!f.statuses.includes('running'))
  assert.equal(f.statuses.at(-1), 'idle')
  const calls = (await f.rpc()).map((entry) => entry.method)
  assert.ok(!calls.includes('session/prompt') && !calls.includes('session/set_config_option'))
  assert.equal(AGENT_CAPABILITIES.copilot.cliSessions, true)
})

test('Copilot lists the native sessions of one directory', async (t) => {
  const { root, binary } = await agent(t)
  const listed = await listCopilotSessions(binary, root)
  assert.deepEqual(listed.sessions.map((session) => [session.sessionId.slice(0, 4), session.title]), [['1111', 'Fix the login form'], ['2222', 'Older work']])
  assert.equal(listed.sessions[0]!.lastModified, Date.parse('2026-11-27T10:00:00.000Z'))
})

test('Copilot interrupts the turn through session/cancel', async (t) => {
  const f = await fixture(t)
  await f.runner.send('fixture:' + JSON.stringify({ steps: [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'rm -rf build', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build', description: 'Remove the build' } } },
    { permission: { toolCall: { toolCallId: 'x', title: 'rm -rf build', kind: 'execute', rawInput: { command: 'rm -rf build', commands: ['rm'] } }, options: PERMISSION_OPTIONS } },
  ] }), [], [], [])
  await until(() => f.of('permission.requested').length > 0)
  await f.runner.interrupt()
  await until(() => f.of('turn.completed').length > 0)
  assert.equal(f.of('turn.completed')[0]!.stopReason, 'interrupted')
  // The call never closed, and Copilot's "Info: Operation cancelled by user" is not a reply.
  assert.deepEqual(f.of('tool.completed').map((event) => [event.toolCallId, event.isError]), [['x', true]])
  assert.equal(f.of('message.completed').length, 0)
  assert.equal(f.of('turn.started').length, 1)
})

test('Copilot quota comes from what each model call reports', async (t) => {
  // A plan billed in premium requests, as the CLI's schema describes it.
  const quota = { premium_interactions: { entitlementRequests: 300, usedRequests: 285, resetDate: '2026-12-01T00:00:00.000Z', overageAllowedWithExhaustedQuota: false }, chat: { isUnlimitedEntitlement: true, entitlementRequests: 0, usedRequests: 12 }, completions: { hasQuota: false } }
  assert.deepEqual(copilotUsage(null), { agent: 'copilot', plan: null, limitsAvailable: false, windows: [], credits: null, fetchedAt: copilotUsage(null).fetchedAt })
  assert.deepEqual(copilotUsage({ quota, credits: false, at: 42 }), { agent: 'copilot', plan: null, limitsAvailable: true, windows: [{ id: 'premium_interactions', label: 'Premium requests', utilization: 0.95, resetsAt: Date.parse('2026-12-01T00:00:00.000Z') }], credits: null, fetchedAt: 42 })
  // A full quota warns; only a refused request stops the account.
  const full = quotaLimit({ premium_interactions: { entitlementRequests: 300, usedRequests: 320, resetDate: '2026-12-01T00:00:00.000Z' } })!
  assert.deepEqual([full.status, full.utilization], ['allowed_warning', 1])
  assert.deepEqual(refusedLimit('quota', full), { ...full, status: 'rejected' })
  assert.equal(quotaLimit({ chat: { isUnlimitedEntitlement: true } }), null)

  // As a signed-in account billed in AI credits reported it after a few turns: `chat` is the
  // monthly credit budget, precise in its percentage only; the editor's completions are not
  // the CLI's; no premium entitlement is not a quota used up.
  const credits = {
    chat: { isUnlimitedEntitlement: false, entitlementRequests: 200, usedRequests: 1, usageAllowedWithExhaustedQuota: false, overage: 0, overageAllowedWithExhaustedQuota: false, remainingPercentage: 99.7, resetDate: '2026-12-01T00:00:00Z' },
    completions: { isUnlimitedEntitlement: false, entitlementRequests: 2000, usedRequests: 432, remainingPercentage: 78.4, resetDate: '2026-12-01T00:00:00Z' },
    premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0, resetDate: '2026-12-01T00:00:00Z' },
  }
  assert.deepEqual(copilotUsage({ quota: credits, credits: true, at: 1 }).windows, [{ id: 'chat', label: 'AI credits', utilization: 0.003, resetsAt: Date.parse('2026-12-01T00:00:00Z') }])
  assert.deepEqual(quotaLimit(credits), { type: 'chat', status: 'allowed', utilization: 0.003, resetsAt: Date.parse('2026-12-01T00:00:00Z'), overageEnabled: false })

  const f = await fixture(t)
  await f.turn([
    { event: { type: 'assistant.usage', data: { model: 'gpt-test', modelDisplayName: 'GPT Test', isAuto: true, inputTokens: 10, outputTokens: 1, quotaSnapshots: quota } } },
    { event: { type: 'assistant.usage', data: { model: 'gpt-test', modelDisplayName: 'GPT Test', isAuto: true, inputTokens: 10, outputTokens: 1, quotaSnapshots: quota, copilotUsage: { totalNanoAiu: 25336000 } } } },
    chunk('Done', 'r1'),
  ])
  assert.deepEqual(f.quotas, [[quota, false], [quota, true]])
  // The last reading per home outlives a server restart; an unreadable file is no reading.
  const file = join(f.root, 'state', 'quota.json')
  saveObservedQuotas(file, new Map([['', { quota, credits: true, at: 7 }], ['/homes/b', { quota: credits, credits: true, at: 8 }]]))
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual([...readObservedQuotas(file)], [['', { quota, credits: true, at: 7 }], ['/homes/b', { quota: credits, credits: true, at: 8 }]])
  await writeFile(file, '{oops')
  assert.equal(readObservedQuotas(file).size, 0)
  assert.equal(readObservedQuotas(join(f.root, 'missing.json')).size, 0)
  // A server started later shows the gauge before any turn.
  saveObservedQuotas(file, new Map([['', { quota: credits, credits: true, at: 9 }]]))
  const adapter = new CopilotAdapter({ agents: { copilot: { binary: f.binary, enabled: true } }, paths: { agents: join(f.root, 'agents'), copilot: join(f.root, 'state') } } as unknown as Config)
  assert.deepEqual((await adapter.usage()).windows.map((window) => [window.label, window.utilization]), [['AI credits', 0.003]])
  // The same reading twice is journaled once.
  assert.deepEqual(f.of('usage.updated').filter((event) => event.rateLimit).map((event) => [event.rateLimit!.type, event.rateLimit!.status, event.rateLimit!.utilization]), [['premium_interactions', 'allowed_warning', 0.95]])
  // Auto routes each request: the model that answered is named once.
  assert.deepEqual(f.of('agent.notice').map((event) => [event.id, event.code, event.details]), [['copilot-auto-model', 'copilot_auto_model', { model: 'GPT Test' }]])
})
