import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { applyEvent, emptyChatState } from '@sillage/protocol/chat-state'
import { DEFAULT_ANTIGRAVITY_CONFIG, sillageEventSchema, type SillageEvent } from '@sillage/protocol'
import { AntigravityRunner } from '../src/agents/antigravity/runner.js'
import { AntigravityCatalog, antigravityProbeFolder, parseUsage } from '../src/agents/antigravity/catalog.js'
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
    // 1.4.3 as probed: the input includes the cache read, the output leaves the reasoning out.
  ], { totalTokens: 60128, inputTokens: 58538, outputTokens: 274, thoughtTokens: 1316, cachedReadTokens: 37124, cachedWriteTokens: 0 })
  const started = f.events.filter((event) => event.type === 'tool.started')
  assert.deepEqual(started.map((event) => event.name), ['Read', 'sillage/create_card', 'Edit'])
  assert.equal(started[1]!.title, 'Record the discovered issue')
  assert.deepEqual(started[1]!.input, { description: 'Resource description' })
  const completed = f.events.findIndex((event) => event.type === 'tool.completed' && event.toolCallId === 'edit')
  assert.match(describeEdit(f.raw[completed], f.root, 'a.txt').patch, /\+b/)
  const end = f.events.find((event) => event.type === 'turn.completed')!
  assert.equal(end.inputTokens, 21414); assert.equal(end.outputTokens, 1590); assert.equal(end.cacheReadTokens, 37124)
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
  assert.equal((next.sqlite.prepare('SELECT value FROM steps').get() as { value: string } | undefined)?.value, 'before switch')
  next.sqlite.exec("INSERT INTO steps VALUES ('after switch')")
  await rememberAntigravityStorage(managed, homes.sessions('owner'), 'session')
  await prepareAntigravityResume(native, homes.sessions('owner'), 'session')
  next.sqlite.close()
  const back = openDatabase(history)
  try { assert.equal((back.sqlite.prepare('SELECT count(*) AS count FROM steps').get() as { count: number } | undefined)?.count, 2) }
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
  const result = await catalog.list(f.home)
  assert.equal(result.models.models[1]!.efforts.length, 2)
  assert.equal((await catalog.usage(f.home)).windows[0]!.label, 'Gemini Pro · Weekly Limit Remaining')
  // Probes open their sessions in Sillage's own folder and take the system skills back out.
  const probed = rpc.length
  const sessions = (await f.rpc()).slice(probed).filter((entry) => entry.method === 'session/new').map((entry) => entry.params.cwd)
  assert.deepEqual(sessions, [antigravityProbeFolder(f.home), antigravityProbeFolder(f.home)])
  assert.equal(existsSync(join(antigravityProbeFolder(f.home), 'skills')), false)
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
  assert.equal(state.items.filter((item) => item.kind === 'tool').find((item) => item.id === 'background')?.status, 'running')
  await f.turn([{ update: { sessionUpdate: 'tool_call_update', toolCallId: 'background', status: 'completed', rawOutput: { commandLine: 'npm test', exitCode: 0, combinedOutput: 'All checks passed' } } }])
  assert.equal(f.events.filter((event) => event.type === 'tool.completed' && event.toolCallId === 'background').length, 1)
  assert.equal(f.events.filter((event) => event.type === 'tool.completed').find((event) => event.toolCallId === 'background')?.output, 'All checks passed')
  assert.deepEqual(f.events.filter((event) => event.type === 'background.updated').at(-1)?.tasks, [])
})

test('A frame failed by the hook broadcast and re-announced keeps one row that ends successfully', async (t) => {
  const f = await fixture(t)
  const start = { sessionUpdate: 'tool_call', toolCallId: 'ls', title: 'ls', kind: 'execute', status: 'in_progress', rawInput: { command_line: 'ls', working_dir: f.root } }
  await f.turn([
    { update: start },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'ls', status: 'failed', rawOutput: 'Access to path "/elsewhere/MEMORY.md" is denied.' } },
    { update: start },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'ls', status: 'completed', rawOutput: { commandLine: 'ls', exitCode: 0, combinedOutput: 'a.txt' } } },
    // The end-of-turn sweep repeats a bare status for a frame already closed.
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'ls', status: 'completed' } },
  ])
  assert.equal(f.events.filter((event) => event.type === 'tool.started').length, 1)
  assert.deepEqual(f.events.filter((event) => event.type === 'tool.completed').map((event) => [event.isError, event.output]), [[true, 'Access to path "/elsewhere/MEMORY.md" is denied.'], [false, 'a.txt']])
  const state = emptyChatState()
  f.events.forEach((event, index) => applyEvent(state, index + 1, Date.now(), event))
  const rows = state.items.filter((item) => item.kind === 'tool' && item.id === 'ls')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.kind === 'tool' ? rows[0]!.status : null, 'done')
})

test('Unclosed file reads are shown from disk and late bare closings add nothing', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'notes.txt'), 'one\ntwo\nthree\nfour\n')
  const previous = AntigravityRunner.readSettleMs
  AntigravityRunner.readSettleMs = 30
  t.after(() => { AntigravityRunner.readSettleMs = previous })
  await f.turn([
    { update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: join(f.root, 'notes.txt'), StartLine: 2, EndLine: 3 } } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'call_2', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: join(f.root, 'missing.txt') } } },
    { wait: 120 },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'failed', rawOutput: 'file not found' } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'call_3', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: join(f.root, 'notes.txt') } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_3', status: 'completed' } },
  ])
  const completed = f.events.filter((event) => event.type === 'tool.completed')
  assert.deepEqual(completed.map((event) => [event.toolCallId, event.isError, event.output]), [
    ['call_1', false, 'two\nthree'],
    ['call_2', true, 'file not found'],
    ['call_3', false, 'one\ntwo\nthree\nfour\n'],
  ])
  assert.equal(f.events.filter((event) => event.type === 'tool.started').length, 3)
})

test('Mirrored reads of huge or binary files stay bounded', async (t) => {
  const f = await fixture(t)
  // Larger than the scanned prefix: the first lines are still shown, the rest is not read.
  const line = `${'x'.repeat(99)}\n`
  await writeFile(join(f.root, 'huge.log'), `first\nsecond\n${line.repeat(60_000)}`)
  await writeFile(join(f.root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x0d, 0x0a]))
  await f.turn([
    { update: { sessionUpdate: 'tool_call', toolCallId: 'head', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: join(f.root, 'huge.log'), StartLine: 1, EndLine: 2 } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'head', status: 'completed' } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'tail', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: join(f.root, 'huge.log'), StartLine: 59_000, EndLine: 59_001 } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tail', status: 'completed' } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'whole', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: join(f.root, 'huge.log') } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'whole', status: 'completed' } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'binary', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: join(f.root, 'image.png') } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'binary', status: 'completed' } },
  ])
  const output = (id: string) => {
    const event = f.events.find((entry) => entry.type === 'tool.completed' && entry.toolCallId === id)
    return event?.type === 'tool.completed' ? event.output : undefined
  }
  assert.equal(output('head'), 'first\nsecond')
  assert.ok(!output('tail'), 'lines past the scanned prefix are not invented')
  const whole = String(output('whole'))
  assert.ok(whole.endsWith('… (truncated)'))
  assert.ok(whole.length <= 512 * 1024 + 20)
  assert.ok(!output('binary'), 'binary content is not decoded into the journal')
})

test('A dead command sandbox is explained once', async (t) => {
  const f = await fixture(t)
  const error = 'error executing cascade step: CORTEX_STEP_TYPE_RUN_COMMAND: connecting to sandbox server: read unix @ -> @: recvmsg: connection reset by peer'
  await f.turn([
    { update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'ls', kind: 'execute', status: 'in_progress', rawInput: { command_line: 'ls', working_dir: f.root } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'failed', rawOutput: error } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: join(f.root, 'a.txt') } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed', rawOutput: error } },
  ])
  const notices = f.events.filter((event) => event.type === 'agent.notice' && event.code === 'antigravity_sandbox_unavailable')
  assert.equal(notices.length, 1)
  assert.equal(notices[0]!.type === 'agent.notice' ? notices[0]!.level : null, 'warning')
  assert.equal(f.events.filter((event) => event.type === 'tool.completed' && event.isError).length, 2)
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

test('Antigravity sub-agents settle their own tokens at each turn end, once, nested ones included', async (t) => {
  const f = await fixture(t)
  const sessionId = f.events.find((event) => event.type === 'session.started')!.agentSessionId
  const brain = join(antigravitySessionHome(f.home, 'conversation', []), 'antigravity-acp', 'brain')
  const transcript = async (id: string, steps: Record<string, unknown>[], append = false) => {
    const dir = join(brain, id, '.system_generated', 'logs')
    await mkdir(dir, { recursive: true })
    const text = steps.map((step) => JSON.stringify(step) + '\n').join('')
    await writeFile(join(dir, 'transcript_full.jsonl'), append ? (await readFile(join(dir, 'transcript_full.jsonl'), 'utf8').catch(() => '')) + text : text)
  }
  const planner = (step_index: number, input_tokens: number, cache_read_tokens: number, output_tokens: number) => ({ step_index, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-27T19:52:11Z', input_tokens, cache_read_tokens, output_tokens })
  const invoke = (step_index: number, ...ids: string[]) => ({ step_index, type: 'INVOKE_SUBAGENT', status: 'DONE', content: `Created the following subagents:\n${ids.map((id) => `{\n  "conversationId":  "${id}"\n}`).join('\n')}` })
  // The main transcript's own steps are the prompt's usage: never counted here.
  await transcript(sessionId, [planner(1, 13804, 0, 427), invoke(6, 'child')])
  await transcript('child', [planner(1, 5827, 0, 217), planner(2, 1000, 2000, 30), invoke(3, 'grandchild')])
  await transcript('grandchild', [planner(1, 10, 20, 3)])
  await f.turn([], { totalTokens: 10, inputTokens: 8, outputTokens: 2, thoughtTokens: 0, cachedReadTokens: 0 })
  const consumed = () => f.events.filter((event) => event.type === 'usage.consumed')
  assert.deepEqual(consumed().map(({ inputTokens, outputTokens, cacheReadTokens }) => [inputTokens, outputTokens, cacheReadTokens]), [[6827, 247, 2000], [10, 3, 20]])
  // Settled before the turn closes.
  assert.ok(f.events.findIndex((event) => event.type === 'usage.consumed') < f.events.findIndex((event) => event.type === 'turn.completed'))

  // A sub-agent still working: only its new steps, and a step written out of order or twice once.
  await transcript('child', [planner(5, 100, 0, 7), planner(4, 50, 0, 1), planner(2, 1000, 2000, 30)], true)
  await f.turn([])
  assert.deepEqual(consumed().slice(2).map(({ inputTokens, outputTokens }) => [inputTokens, outputTokens]), [[150, 8]])
  await f.turn([])
  assert.equal(consumed().length, 3)

  // A resumed session starts from what is on disk: earlier runners counted it.
  const before = consumed().length
  const resumed = new AntigravityRunner({ ...f.ctx, resumeSessionId: sessionId })
  t.after(() => resumed.stop())
  await resumed.start()
  const ended = f.events.filter((event) => event.type === 'turn.completed').length
  await resumed.send('fixture:' + JSON.stringify({ steps: [] }), [], [], [])
  await until(() => f.events.filter((event) => event.type === 'turn.completed').length > ended)
  assert.equal(consumed().length, before)
})
