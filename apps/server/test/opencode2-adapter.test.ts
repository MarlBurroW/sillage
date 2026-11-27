import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_OPENCODE_CONFIG, PREFERRED_CLI_RELEASES, isCompatibleCliVersion } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import type { EventLog } from '../src/events/event-log.js'
import { OpencodeAdapter } from '../src/agents/opencode/adapter.js'
import { SessionGrants, matchesPattern } from '../src/agents/opencode/v2/permissions.js'
import { describeTool } from '../src/agents/opencode/v2/tools.js'
import { fixture2 } from './opencode2-support.js'

async function adapterFixture(t: Parameters<typeof fixture2>[0]) {
  const transport = await fixture2(t)
  const config = { agents: { opencode: { binary: transport.binary, enabled: true } }, paths: { agents: transport.cwd } } as unknown as Config
  return { ...transport, adapter: new OpencodeAdapter(config) }
}

function logWith(raws: Record<string, unknown>, tool: unknown = null): EventLog {
  return {
    lastRawOfType: (_id: string, type: string) => raws[type] ?? null,
    rawOfTool: () => ({ completed: tool }),
  } as unknown as EventLog
}

test('OpenCode 2 : catalogue des modèles utilisables, variantes, agents par identifiant', async (t) => {
  const { adapter, cwd } = await adapterFixture(t)
  const listing = await adapter.models()
  // Deprecated models are left out; `default` is the absence of a variant.
  assert.deepEqual(listing.models[0], {
    value: 'fixture/small', displayName: 'Small', description: 'fixture', hint: 'fixture/small', group: 'Fixture Cloud', isDefault: true,
    efforts: [{ value: 'low', label: 'low', hint: null }, { value: 'high', label: 'high', hint: null }],
    defaultEffort: null, supportsFastMode: false,
  })
  // Filed by provider name, and Copilot's Auto router leads its section.
  assert.deepEqual(listing.models.map((model) => [model.group, model.value]), [
    ['Fixture Cloud', 'fixture/small'],
    ['GitHub Copilot', 'github-copilot/auto'],
    ['GitHub Copilot', 'github-copilot/claude'],
  ])
  // 2.x prompts name agents by ID, shown under their display name.
  assert.deepEqual(listing.modes, [{ mode: 'build', label: 'Build', hint: 'Default agent' }])
  assert.deepEqual(listing.agents, [{ name: 'general', description: 'General work' }])
  assert.equal((await adapter.resolveDefaults(DEFAULT_OPENCODE_CONFIG)).model, 'fixture/small')
  assert.deepEqual((await adapter.commands(cwd, false)).commands.map((command) => command.name), ['review'])
  assert.equal((await adapter.cli.describe()).version, '2.4.2')
})

test('OpenCode 2 : fork au message qui suit le dernier gardé, coupe lue dans les deux formats', async (t) => {
  const { adapter, cwd, records } = await adapterFixture(t)
  const target = { agentSessionId: 'ses_root', cwd }

  // 2.x messages carry their ID under `data`; the later of both markers wins.
  const cut = adapter.forkCut(logWith({ 'turn.completed': { messageID: 'msg_1' }, 'message.completed': { data: { assistantMessageID: 'msg_2' } } }), 'c', 10)
  assert.deepEqual(cut, { lastMessageId: 'msg_2' })
  assert.equal(await adapter.fork(target, cut), 'ses_fork')
  assert.equal(await adapter.fork(target, { lastMessageId: 'msg_4' }), 'ses_fork')
  const forks = (await records()).filter((record) => record.path.endsWith('/fork'))
  assert.deepEqual(forks.map((record) => [record.path, record.body]), [['/api/session/ses_root/fork', { before: 'msg_3' }], ['/api/session/ses_root/fork', {}]])
})

test('OpenCode 2 : la coupe d’un fork se cherche au-delà de la première page d’historique', async (t) => {
  const { adapter, cwd, records } = await adapterFixture(t)
  const target = { agentSessionId: 'ses_long', cwd }
  // 250 messages: the default page only holds the last 50, and a page of 200 the first 200.
  assert.equal(await adapter.fork(target, { lastMessageId: 'msg_010' }), 'ses_fork')
  assert.equal(await adapter.fork(target, { lastMessageId: 'msg_229' }), 'ses_fork')
  assert.equal(await adapter.fork(target, { lastMessageId: 'msg_250' }), 'ses_fork')
  const forks = (await records()).filter((record) => record.path.endsWith('/fork')).map((record) => record.body)
  assert.deepEqual(forks, [{ before: 'msg_011' }, { before: 'msg_230' }, {}])
})

test('OpenCode 2 : outils renommés et diff des éditions journalisées', async (t) => {
  assert.deepEqual(describeTool('shell', { command: 'ls', workdir: '/w' }, []), { name: 'Bash', input: { command: 'ls', cwd: '/w' } })
  assert.deepEqual(describeTool('read', { path: '/a', offset: 2 }, []), { name: 'Read', input: { file_path: '/a', offset: 2 } })
  assert.equal(describeTool('sillage_read_card', {}, ['sillage']).name, 'sillage/read_card')

  const { adapter } = await adapterFixture(t)
  const describe = (call: unknown, path: string) =>
    adapter.describeEdit({ log: logWith({}, { type: 'session.tool.success', call }), conversationId: 'c', toolCallId: 't', cwd: '/w', path })
  const edit = { tool: 'edit', input: { path: '/w/a.txt' }, output: 'Edited',
    metadata: { files: [{ file: 'a.txt', patch: 'Index: a.txt\n===\n--- a.txt\n+++ a.txt\n@@ -1,1 +1,2 @@\n a\n+b\n', status: 'modified' }] } }
  assert.deepEqual(describe(edit, 'a.txt'), {
    path: 'a.txt', kind: 'patch', content: '', partial: false, reason: null,
    patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,2 @@\n a\n+b\n',
  })
  const created = { tool: 'write', input: { path: '/w/n.txt', content: 'abc' }, output: 'Created file successfully: n.txt', metadata: {} }
  assert.match(describe(created, 'n.txt').patch, /new file mode[\s\S]*\+abc$/)
  const rewritten = { ...created, output: 'Wrote file successfully: n.txt' }
  assert.deepEqual([describe(rewritten, 'n.txt').kind, describe(rewritten, 'n.txt').content], ['content', 'abc'])
  // Neither format: the 1.x reader answers that the detail is gone.
  assert.equal(describe(undefined, 'a.txt').kind, 'unavailable')
})

test('versions : Sillage installe la 2.x et reconnaît encore la 1.x', () => {
  const release = PREFERRED_CLI_RELEASES.opencode
  assert.equal(release.package, '@opencode/cli')
  // The 1.x package claims the same command: it leaves the prefix first.
  assert.deepEqual(release.replaces, ['opencode-ai'])
  assert.deepEqual(['1.19.5', '1.20.0', '2.4.2', '2.9.0', '1.18.0', '2.4.1', '3.0.0', 'nightly'].map((version) => isCompatibleCliVersion(release, version)),
    [true, true, true, true, false, false, false, null])
  // CLIs with a single target keep the caret rule.
  assert.equal(isCompatibleCliVersion(PREFERRED_CLI_RELEASES.codex, '1.0.0'), false)
})


test('OpenCode 2 : sessions natives listées puis importées sans requête au modèle', async (t) => {
  const { adapter, cwd, binary, records } = await adapterFixture(t)
  assert.deepEqual(await adapter.nativeSessions(cwd), [
    // Not titled yet: named by its first prompt rather than its ID.
    { sessionId: 'ses_untitled', title: 'Draft the release notes', firstPrompt: 'Draft the release notes', gitBranch: null, lastModified: 18 },
    { sessionId: 'ses_native', title: 'Native work', firstPrompt: null, gitBranch: null, lastModified: 17 },
  ])
  const listing = (await records()).find((record) => record.path === '/api/session')
  assert.ok(listing, 'listed through the session route')

  const { context } = await import('./opencode-support.js')
  const { OpencodeRunnerSwitch } = await import('../src/agents/opencode/runner-switch.js')
  const formats: (string | undefined)[] = []
  const state = context({ cwd, binary, resumeSessionId: 'ses_native' })
  const emit = state.ctx.emit
  state.ctx.emit = (event, raw, rawFormat) => { formats.push(rawFormat); emit(event, raw) }
  const runner = new OpencodeRunnerSwitch(state.ctx)
  t.after(() => runner.stop())
  await runner.importHistory()

  const types = state.events.map((event) => event.type).filter((type) => !['session.started', 'background.updated'].includes(type))
  assert.deepEqual(types, [
    'turn.started', 'message.completed', 'message.completed', 'tool.started', 'tool.completed', 'file.edited', 'message.completed', 'turn.completed',
    'turn.started', 'tool.started', 'tool.completed', 'context.compacted', 'tool.started', 'tool.completed', 'turn.completed',
  ])
  const done = state.events.filter((event) => event.type === 'turn.completed')
  assert.deepEqual(done.map((event) => event.type === 'turn.completed' && [event.stopReason, event.costUsd, event.inputTokens, event.outputTokens, event.cacheReadTokens]),
    [['completed', 0.25, 50, 12, 100], ['interrupted', 0, 0, 0, 0]])
  assert.deepEqual(state.raw[state.events.indexOf(done[0]!)], { sessionID: 'ses_native', messageID: 'msg_03' })
  const tools = state.events.filter((event) => event.type === 'tool.started')
  assert.deepEqual(tools.map((event) => event.type === 'tool.started' && [event.name, event.input]), [
    ['Edit', { file_path: '/w/a.txt', old_string: 'teh', new_string: 'the' }],
    ['Bash', { command: 'ls' }],
    ['Bash', { command: 'false' }],
  ])
  const failed = state.events.filter((event) => event.type === 'tool.completed').at(-1)
  assert.deepEqual(failed, { type: 'tool.completed', toolCallId: 'call_b', output: 'exit 1', isError: true, durationMs: 1 })
  // Imported edits keep their diff, like live ones.
  const edit = adapter.describeEdit({ log: logWith({}, state.raw[state.events.findIndex((event) => event.type === 'tool.completed')]), conversationId: 'c', toolCallId: 'call_e', cwd: '/w', path: 'a.txt' })
  assert.equal(edit.kind, 'patch')
  assert.ok(formats.every((format) => format === 'opencode-server@v2'))
  assert.ok(!(await records()).some((record) => record.path.endsWith('/prompt')), 'no model request')
  assert.deepEqual(state.statuses.at(-1), 'idle')
})

test('OpenCode 2 : motifs de session lus comme opencode 2.4.2', () => {
  // A trailing ` *` also covers the bare command, but not a longer word.
  assert.equal(matchesPattern('echo one', 'echo *', 'linux'), true)
  assert.equal(matchesPattern('echo', 'echo *', 'linux'), true)
  assert.equal(matchesPattern('echoes', 'echo *', 'linux'), false)
  assert.equal(matchesPattern('git log a.b', 'git log a.b', 'linux'), true)
  assert.equal(matchesPattern('git log axb', 'git log a.b', 'linux'), false)
  assert.equal(matchesPattern('https://example.com/a', 'https://example.com/*', 'linux'), true)
  assert.equal(matchesPattern('https://evil.test/?x=https://example.com/', 'https://example.com/*', 'linux'), false)
  // Windows: backslashes read as slashes, case ignored.
  assert.equal(matchesPattern('C:\\Repo\\a.ts', 'c:/repo/*', 'win32'), true)
  assert.equal(matchesPattern('C:/Repo/a.ts', 'c:/repo/*', 'linux'), false)

  const grants = new SessionGrants('linux')
  grants.grant('edit', ['src/a.ts'], undefined)
  assert.equal(grants.covers('edit', ['src/a.ts']), true)
  assert.equal(grants.covers('edit', ['src/b.ts']), false)
  assert.equal(grants.covers('edit', []), false)
  assert.equal(grants.covers('shell', ['src/a.ts']), false)
})
