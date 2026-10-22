import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_OPENCODE_CONFIG, agentConfigSchema, isPermissiveConfig, parseAgentConfig } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import type { EventLog } from '../src/events/event-log.js'
import { OpencodeAdapter } from '../src/agents/opencode/adapter.js'
import { opencodeErrorCode } from '../src/agents/opencode/errors.js'
import { parseModel } from '../src/agents/opencode/model.js'
import { describeEdit, describeTool } from '../src/agents/opencode/tools.js'
import { ForkError } from '../src/agents/registry.js'
import { fixture } from './opencode-support.js'

async function adapterFixture(t: Parameters<typeof fixture>[0]) {
  const transport = await fixture(t)
  const config = { agents: { opencode: { binary: transport.binary, enabled: true } }, paths: { agents: transport.cwd } } as unknown as Config
  return { ...transport, adapter: new OpencodeAdapter(config) }
}

/** Journal reduced to fields read by `forkCut`. */
function logWith(raws: Record<string, unknown>): EventLog {
  return { lastRawOfType: (_id: string, type: string) => raws[type] ?? null } as unknown as EventLog
}

test('catalogue : modèles des fournisseurs connectés, variantes, agents primaires, défauts', async (t) => {
  const { adapter, cwd } = await adapterFixture(t)
  const listing = await adapter.models()
  assert.deepEqual(listing.models, [{
    value: 'fixture/small', displayName: 'Small', description: 'Fixture', hint: 'fixture/small', isDefault: true,
    efforts: [{ value: 'low', label: 'low', hint: null }, { value: 'high', label: 'high', hint: null }],
    defaultEffort: null, supportsFastMode: false,
  }])
  assert.deepEqual(listing.modes, [{ mode: 'build', label: 'build', hint: 'Default agent' }])
  assert.deepEqual(listing.agents, [{ name: 'explore', description: 'Explores' }])

  assert.equal((await adapter.resolveDefaults(DEFAULT_OPENCODE_CONFIG)).model, 'fixture/small')
  const chosen = { ...DEFAULT_OPENCODE_CONFIG, model: 'other/model' }
  assert.equal(await adapter.resolveDefaults(chosen), chosen)

  assert.deepEqual((await adapter.commands(cwd, false)).commands.map((command) => [command.name, command.argumentHint]),
    [['review', '$ARGUMENTS'], ['lib-skill', '']])
  assert.deepEqual({ ...(await adapter.usage()), fetchedAt: 0 },
    { agent: 'opencode', plan: null, limitsAvailable: false, windows: [], credits: null, fetchedAt: 0 })
  assert.equal((await adapter.cli.describe()).version, '1.19.0')
})

test('fork : coupe au message qui suit le dernier gardé, ou garde tout', async (t) => {
  const { adapter, cwd, records } = await adapterFixture(t)
  const target = { agentSessionId: 'ses_root', cwd }

  // Latest of the two journal markers wins.
  const cut = adapter.forkCut(logWith({ 'turn.completed': { messageID: 'msg_2' }, 'message.completed': { part: { messageID: 'msg_1' } } }), 'c', 10)
  assert.deepEqual(cut, { lastMessageId: 'msg_2' })
  assert.equal(await adapter.fork(target, cut), 'ses_fork')
  assert.equal(await adapter.fork(target, { lastMessageId: 'msg_4' }), 'ses_fork')
  const forks = (await records()).filter((record) => record.path.endsWith('/fork'))
  assert.deepEqual(forks.map((record) => record.body), [{ messageID: 'msg_3' }, {}])

  // No agent content before requested points means nothing to fork.
  const empty = adapter.forkCut(logWith({}), 'c', 1)
  assert.deepEqual(empty, { lastMessageId: null })
  await assert.rejects(adapter.fork(target, empty), ForkError)
})

test('outils : noms et champs du journal, serveurs MCP, diff des éditions', () => {
  assert.deepEqual(describeTool('read', { filePath: '/a', offset: 2 }, []), { name: 'Read', input: { file_path: '/a', offset: 2 } })
  assert.deepEqual(describeTool('task', { prompt: 'p' }, []), { name: 'Agent', input: { prompt: 'p' } })
  // Longest prefixes win; unknown tools retain their names.
  assert.equal(describeTool('git_hub_search', {}, ['git', 'git_hub']).name, 'git_hub/search')
  assert.equal(describeTool('custom_tool', {}, ['other']).name, 'custom_tool')

  const edit = { part: { type: 'tool', tool: 'edit', callID: 'c', state: { status: 'completed', input: { filePath: '/w/a.txt' },
    metadata: { diff: 'Index: /w/a.txt\n====\n--- /w/a.txt\n+++ /w/a.txt\n@@ -1,1 +1,2 @@\n a\n+b\n', filediff: { file: '/w/a.txt' } } } } }
  assert.deepEqual(describeEdit(edit, '/w', 'a.txt'), {
    path: 'a.txt', kind: 'patch', content: '', partial: false, reason: null,
    patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,2 @@\n a\n+b\n',
  })
  const created = { part: { type: 'tool', tool: 'write', callID: 'c', state: { status: 'completed',
    input: { filePath: '/w/n.txt', content: 'abc' }, metadata: { filepath: '/w/n.txt', exists: false } } } }
  assert.match(describeEdit(created, '/w', 'n.txt').patch, /new file mode[\s\S]*\+abc$/)
  assert.equal(describeEdit(created, '/w', 'other.txt').kind, 'unavailable')
  assert.equal(describeEdit(null, '/w', 'a.txt').kind, 'unavailable')
})

test('modèle, codes d\'erreur et configuration', () => {
  assert.deepEqual(parseModel('openrouter/anthropic/claude'), { providerID: 'openrouter', modelID: 'anthropic/claude' })
  assert.equal(parseModel(''), null)
  assert.equal(parseModel('sans-fournisseur'), null)

  assert.equal(opencodeErrorCode('ProviderAuthError'), 'provider_unauthorized')
  assert.equal(opencodeErrorCode('ContextOverflowError'), 'context_overflow')
  assert.equal(opencodeErrorCode('APIError'), 'api_error')
  assert.equal(opencodeErrorCode('UnknownError'), 'turn_failed')

  // Configurations predating settings load with defaults.
  const stored = parseAgentConfig(JSON.stringify({ agent: 'opencode', model: 'a/b' }))
  assert.deepEqual(stored, { ...DEFAULT_OPENCODE_CONFIG, model: 'a/b' })
  assert.equal(isPermissiveConfig(DEFAULT_OPENCODE_CONFIG), false)
  assert.equal(isPermissiveConfig(agentConfigSchema.parse({ ...DEFAULT_OPENCODE_CONFIG, permissions: { edit: 'allow', bash: '' } })), true)
})
