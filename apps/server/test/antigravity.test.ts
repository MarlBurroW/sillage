import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { applyEvent, emptyChatState } from '@sillage/protocol/chat-state'
import { DEFAULT_ANTIGRAVITY_CONFIG, sillageEventSchema, type SillageEvent } from '@sillage/protocol'
import { AntigravityRunner } from '../src/agents/antigravity/runner.js'
import { AntigravityCatalog, parseUsage } from '../src/agents/antigravity/catalog.js'
import { AntigravityAccountHomes, antigravityEnv, antigravitySessionHome, writeAntigravityCredentials } from '../src/antigravity-accounts/homes.js'
import { validateAntigravityCallback } from '../src/antigravity-accounts/login.js'
import { describeEdit } from '../src/agents/acp/content.js'
import type { RunnerContext } from '../src/agents/types.js'
import { openDatabase } from '@sillage/db'
import { persistAntigravityArtifacts, prepareAntigravityResume, rememberAntigravityStorage } from '../src/antigravity-accounts/session-storage.js'
import { sniffMimeType } from '../src/attachments/store.js'
import { describeAntigravityTool } from '../src/agents/antigravity/tools.js'

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 5)) }
}
async function fixture(t: TestContext, changes: Partial<RunnerContext> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sillage-antigravity-'))
  const binary = join(root, 'agent.mjs')
  const home = join(root, 'home')
  await copyFile(new URL('./fixtures/antigravity-agent.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)
  const events: SillageEvent[] = [], raw: unknown[] = []
  const ctx: RunnerContext = {
    conversationId: 'conversation', cwd: root, binary, config: DEFAULT_ANTIGRAVITY_CONFIG, attachmentsRoot: root, processEnv: { GEMINI_HOME: home }, resumeSessionId: null,
    projectOverview: () => 'Shared instructions and memory', maskedInstructionRoots: () => [], memoryDir: () => null, skillRoots: () => [], resolveMcpServers: () => ({ servers: [], failures: [] }),
    emit: (event, native) => { sillageEventSchema.parse(event); events.push(event); raw.push(native) }, setStatus: () => {}, setAgentSessionId: () => {}, updateConfig: () => {}, openPermissionRequest: () => randomUUID(), closePermissionRequest: () => {}, ...changes,
  }
  const runner = new AntigravityRunner(ctx)
  t.after(async () => { await runner.stop(); await rm(root, { recursive: true, force: true }) })
  await runner.start()
  const rpc = async () => (await readFile(join(root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const turn = async (steps: unknown[], usage = {}) => {
    const count = events.filter((entry) => entry.type === 'turn.completed').length
    await runner.send('fixture:' + JSON.stringify({ steps, usage }), [], [], [])
    await until(() => events.filter((entry) => entry.type === 'turn.completed').length > count)
  }
  return { root, home, binary, ctx, runner, events, raw, rpc, turn }
}

test('Antigravity streams human tool metadata, edits, thoughts and ACP token usage', async (t) => {
  const f = await fixture(t)
  await f.turn([
    { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking' } } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Running view_file', kind: 'read', rawInput: { AbsolutePath: join(f.root, 'a.txt') } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: 'a' } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'mcp', title: 'sillage_create_card', rawInput: { arguments: { description: 'Resource description' } }, _meta: { mcp: { server: 'sillage', tool: 'create_card' }, prompt: 'Record the discovered issue' } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'mcp', status: 'completed', rawOutput: 'Created' } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Running replace_file_content', rawInput: { TargetFile: join(f.root, 'a.txt'), TargetContent: 'a', ReplacementContent: 'b' }, content: [{ type: 'diff', path: join(f.root, 'a.txt'), oldText: 'a', newText: 'b' }] } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' } },
  ], { inputTokens: 2, outputTokens: 3, cachedReadTokens: 7, thoughtTokens: 5 })
  const started = f.events.filter((event) => event.type === 'tool.started')
  assert.deepEqual(started.map((event) => event.name), ['Read', 'sillage/create_card', 'Edit'])
  assert.equal(started[1]!.title, 'Record the discovered issue')
  assert.deepEqual(started[1]!.input, { description: 'Resource description' })
  const completed = f.events.findIndex((event) => event.type === 'tool.completed' && event.toolCallId === 'edit')
  assert.match(describeEdit(f.raw[completed], f.root, 'a.txt').patch, /\+b/)
  const end = f.events.find((event) => event.type === 'turn.completed')!
  assert.equal(end.inputTokens, 2); assert.equal(end.outputTokens, 8); assert.equal(end.cacheReadTokens, 7)
  const created = (await f.rpc()).find((entry) => entry.method === 'session/new')
  assert.equal(created.params._meta.antigravity.systemPrompt.append, 'Shared instructions and memory')
  assert.deepEqual(f.events.find((event) => event.type === 'commands.updated')?.commands.map((command) => command.name), ['plan', 'usage', 'logout'])
  assert.equal(f.events.filter((event) => event.type === 'mcp.updated').at(-1)?.servers.find((entry) => entry.name === 'sillage')?.state, 'connected')
})

test('Native history imports reuse tool translation and retain user turns without inference', async (t) => {
  const f = await fixture(t)
  await f.runner.stop()
  await writeFile(join(f.root, 'history.json'), JSON.stringify([
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Read this file' } },
    { sessionUpdate: 'tool_call', toolCallId: 'historical', title: 'Running view_file', rawInput: JSON.stringify({ AbsolutePath: '/project/file.txt' }) },
    { sessionUpdate: 'tool_call_update', toolCallId: 'historical', status: 'completed', rawOutput: 'The content' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First answer' } },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Explain' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second answer' } },
  ]))
  f.events.length = 0
  const runner = new AntigravityRunner({ ...f.ctx, resumeSessionId: 'adopted' })
  try { await runner.importHistory() } finally { await runner.stop() }
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').length, 2)
  assert.deepEqual(f.events.filter((event) => event.type === 'message.completed').map((event) => event.role), ['user', 'assistant', 'user', 'assistant'])
  assert.deepEqual(f.events.find((event) => event.type === 'tool.started')?.input, { file_path: '/project/file.txt' })
  assert.equal((await f.rpc()).some((entry) => entry.method === 'session/prompt'), false)
})

test('Switching default and managed Google accounts preserves committed WAL history in both directions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-google-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const homes = new AntigravityAccountHomes(join(root, 'accounts'), () => 'owner')
  const managed = homes.ensure('account')
  const native = join(root, 'native')
  const history = join(native, 'antigravity-acp', 'conversations', 'session.db')
  const first = openDatabase(history)
  first.sqlite.exec("CREATE TABLE steps (value TEXT); INSERT INTO steps VALUES ('before switch')")
  await rememberAntigravityStorage(native, homes.sessions('owner'), 'session')
  await prepareAntigravityResume(managed, homes.sessions('owner'), 'session')
  first.sqlite.close()
  const next = openDatabase(join(managed, 'antigravity-acp', 'conversations', 'session.db'))
  assert.equal(next.sqlite.prepare('SELECT value FROM steps').get()?.value, 'before switch')
  next.sqlite.exec("INSERT INTO steps VALUES ('after switch')")
  await rememberAntigravityStorage(managed, homes.sessions('owner'), 'session')
  await prepareAntigravityResume(native, homes.sessions('owner'), 'session')
  next.sqlite.close()
  const back = openDatabase(history)
  try { assert.equal(back.sqlite.prepare('SELECT count(*) AS count FROM steps').get()?.count, 2) }
  finally { back.sqlite.close() }
  await assert.rejects(prepareAntigravityResume(native, homes.sessions('owner'), '../escape'))
})

test('Antigravity retains native question IDs and approval choices, then cancels cleanly', async (t) => {
  const f = await fixture(t)
  const run = f.turn([{ permission: { toolCall: { toolCallId: 'interaction_1', title: 'Which branch?', rawInput: {} }, options: [{ optionId: 'native-a', name: 'First', kind: 'allow_once' }, { optionId: 'native-b', name: 'Second', kind: 'allow_once' }] } }])
  await until(() => f.events.some((event) => event.type === 'question.requested'))
  const q = f.events.find((event) => event.type === 'question.requested')!
  assert.equal(q.questions[0]!.allowOther, false)
  f.runner.answerQuestion(q.requestId, { status: 'answered', answers: { interaction_1: ['Second'] }, decidedBy: null })
  await run
  assert.deepEqual((await f.rpc()).find((entry) => entry.answer)?.answer, { outcome: { outcome: 'selected', optionId: 'native-b' } })
  const second = f.turn([{ permission: { toolCall: { toolCallId: 'command', title: 'echo test', kind: 'execute', rawInput: { CommandLine: 'echo test' } }, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Allow this command', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } }])
  await until(() => f.events.some((event) => event.type === 'permission.requested'))
  const permission = f.events.find((event) => event.type === 'permission.requested')!
  assert.equal(permission.suggestions[1]!.label, 'Allow this command')
  await f.runner.interrupt()
  await second
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').at(-1)?.stopReason, 'interrupted')
})

test('Antigravity model options change live and resume never replays persisted history', async (t) => {
  const f = await fixture(t, { resumeSessionId: 'existing' })
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_ANTIGRAVITY_CONFIG, model: 'gemini-fast', reasoningEffort: 'low', permissionMode: 'auto_edit' }), true)
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_ANTIGRAVITY_CONFIG, account: 'another' }), false)
  const rpc = await f.rpc()
  assert.equal(rpc.some((entry) => entry.method === 'session/load'), false)
  assert.equal(rpc.find((entry) => entry.method === 'session/resume').params.sessionId, 'existing')
  assert.deepEqual(rpc.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params.configId), ['model', 'thinking_level', 'mode'])
  const catalog = new AntigravityCatalog(async () => f.binary)
  const result = await catalog.list(f.home, f.root)
  assert.equal(result.models.models[1]!.efforts.length, 2)
  assert.equal((await catalog.usage(f.home)).windows[0]!.label, 'Gemini Pro · Weekly Limit Remaining')
})

test('Google callback relay rejects other ports, states, hosts and credentials', () => {
  const auth = 'https://accounts.google.com/o/oauth2/auth?redirect_uri=' + encodeURIComponent('http://127.0.0.1:34567/') + '&state=ours'
  assert.equal(validateAntigravityCallback(auth, 'http://127.0.0.1:34567/?state=ours&code=code').port, '34567')
  for (const url of ['http://127.0.0.1:34568/?state=ours&code=a', 'http://127.0.0.1:34567/?state=wrong&code=a', 'http://example.com:34567/?state=ours&code=a', 'http://user@127.0.0.1:34567/?state=ours&code=a']) assert.throws(() => validateAntigravityCallback(auth, url))
})

test('Resuming with another account adjusts unavailable model names without loosening permissions', async (t) => {
  const f = await fixture(t, { resumeSessionId: 'existing', config: { ...DEFAULT_ANTIGRAVITY_CONFIG, model: 'old-account-model', reasoningEffort: 'unavailable', permissionMode: 'default' } })
  assert.equal(f.runner.appliedConfig.model, 'gemini-test')
  assert.equal(f.runner.appliedConfig.agent === 'antigravity' && f.runner.appliedConfig.permissionMode, 'default')
  assert.ok(f.events.some((event) => event.type === 'agent.notice' && event.code === 'antigravity_model_adjusted'))
  assert.equal((await f.rpc()).some((entry) => entry.method === 'session/set_config_option'), false)
})

test('Resource descriptions never masquerade as tool actions', () => {
  assert.equal(describeAntigravityTool({ title: 'create_card', rawInput: { description: 'A new feature' }, _meta: { mcp: { server: 'sillage', tool: 'create_card' }, prompt: 'A new feature' } }).title, null)
  assert.equal(describeAntigravityTool({ title: 'Running generate_image', rawInput: { Prompt: 'A red cat' }, _meta: { prompt: 'A red cat' } }).title, null)
  assert.equal(describeAntigravityTool({ title: 'Run view_file?', rawInput: { AbsolutePath: '/project/file' } }).name, 'Read')
})

test('Background command output arrives after the turn without a false interrupted state', async (t) => {
  const f = await fixture(t)
  await f.turn([{ update: { sessionUpdate: 'tool_call', toolCallId: 'background', title: 'npm test', kind: 'execute', status: 'in_progress', rawInput: { command_line: 'npm test', working_dir: f.root } } }])
  const state = emptyChatState()
  f.events.forEach((event, index) => applyEvent(state, index + 1, Date.now(), event))
  assert.equal(state.background[0]?.id, 'background')
  assert.equal(state.items.find((item) => item.kind === 'tool' && item.id === 'background')?.status, 'running')
  await f.turn([{ update: { sessionUpdate: 'tool_call_update', toolCallId: 'background', status: 'completed', rawOutput: { commandLine: 'npm test', exitCode: 0, combinedOutput: 'All checks passed' } } }])
  assert.equal(f.events.filter((event) => event.type === 'tool.completed' && event.toolCallId === 'background').length, 1)
  assert.equal(f.events.find((event) => event.type === 'tool.completed' && event.toolCallId === 'background')?.output, 'All checks passed')
  assert.deepEqual(f.events.filter((event) => event.type === 'background.updated').at(-1)?.tasks, [])
})

test('Attachments stay session-scoped and native logout updates managed account state', async (t) => {
  let loggedOut = false
  const f = await fixture(t, { accountSignedOut: async () => { loggedOut = true } })
  const audio = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(12)])
  const file = join(f.root, 'recording.wav')
  await writeFile(file, audio)
  const mimeType = sniffMimeType(audio, 'recording.wav')
  assert.equal(mimeType, 'audio/wav')
  await f.runner.send('Listen', [{ id: 'audio', filename: 'recording.wav', mimeType, sizeBytes: audio.length, path: file, inlineImage: false }], [], [])
  await until(() => f.events.some((event) => event.type === 'turn.completed'))
  const sent = (await f.rpc()).find((entry) => entry.method === 'session/prompt').params.prompt
  assert.equal(sent[1].type, 'audio')
  assert.equal(sent[1].data, audio.toString('base64'))
  assert.ok(sent[0].text.includes('sillage-sessions'))
  await f.runner.send('/logout', [], [], [])
  await until(() => loggedOut && f.events.filter((event) => event.type === 'turn.completed').length === 2)
})

test('Account homes share histories only within an owner and isolate credentials and project skills', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-google-homes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const homes = new AntigravityAccountHomes(root, (id) => id === 'foreign' ? 'other' : 'owner')
  const first = homes.ensure('first'), second = homes.ensure('second'), foreign = homes.ensure('foreign')
  writeAntigravityCredentials(first, { GEMINI_API_KEY: 'test-only-key' })
  assert.equal(antigravityEnv(first).GEMINI_API_KEY, 'test-only-key')
  assert.equal(antigravityEnv(second).GEMINI_API_KEY, undefined)
  await writeFile(join(first, 'antigravity-acp', 'conversations', 'test'), 'history')
  assert.equal(await readFile(join(second, 'antigravity-acp', 'conversations', 'test'), 'utf8'), 'history')
  await assert.rejects(readFile(join(foreign, 'antigravity-acp', 'conversations', 'test')))
  const library = join(root, 'library')
  await mkdir(join(library, 'skills', 'example'), { recursive: true })
  await writeFile(join(library, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: test\n---\nBody')
  const one = antigravitySessionHome(first, 'one', [library])
  const two = antigravitySessionHome(first, 'two', [])
  assert.match(await readFile(join(one, 'config', 'skills', 'example', 'SKILL.md'), 'utf8'), /Body/)
  await assert.rejects(readFile(join(two, 'config', 'skills', 'example', 'SKILL.md')))
  assert.equal(parseUsage('- **Models**\n  - **Weekly:** 40% remaining').windows[0]!.utilization, 0.6)
})

test('Native artifacts stay inside the allowed home, survive account deletion, and credentials refresh privately', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sillage-google-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const homes = new AntigravityAccountHomes(root, () => 'owner')
  const account = homes.ensure('first')
  const token = join(account, 'antigravity-acp', 'acp_token.json')
  await writeFile(token, '{"fixture":"original"}')
  const view = antigravitySessionHome(account, 'conversation', [])
  const snapshot = join(view, 'antigravity-acp', 'acp_token.json')
  assert.ok((await realpath(snapshot)).startsWith(view))
  await writeFile(snapshot, '{"fixture":"refreshed"}')
  antigravitySessionHome(account, 'conversation', [])
  assert.match(await readFile(snapshot, 'utf8'), /refreshed/)
  await writeFile(token, '{"fixture":"new-login"}')
  antigravitySessionHome(account, 'conversation', [])
  assert.match(await readFile(snapshot, 'utf8'), /new-login/)
  const artifacts = join(view, 'antigravity-acp', 'brain', 'native-id')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'plan.md'), 'The native plan and MCP schemas')
  assert.ok((await realpath(artifacts)).startsWith(view))
  await persistAntigravityArtifacts(view, homes.sessions('owner'), 'native-id')
  await rm(account, { recursive: true })
  const next = antigravitySessionHome(homes.ensure('second'), 'conversation', [])
  await prepareAntigravityResume(next, homes.sessions('owner'), 'native-id')
  assert.match(await readFile(join(next, 'antigravity-acp', 'brain', 'native-id', 'plan.md'), 'utf8'), /native plan/)
  await assert.rejects(readFile(join(next, 'antigravity-acp', 'acp_token.json')))
})
