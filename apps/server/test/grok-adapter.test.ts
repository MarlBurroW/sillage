import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DEFAULT_GROK_CONFIG, isPermissiveConfig, parseAgentConfig } from '@sillage/protocol'
import type { Config } from '../src/config.js'
import type { EventLog } from '../src/events/event-log.js'
import { GrokAdapter } from '../src/agents/grok/adapter.js'
import { describeEdit, describeTool } from '../src/agents/grok/tools.js'
import { ForkError } from '../src/agents/registry.js'

async function adapterFixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'sillage-grok-adapter-'))
  const binary = join(cwd, 'grok.mjs')
  await copyFile(new URL('./fixtures/grok-agent.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const config = { agents: { grok: { binary, enabled: true } }, paths: { agents: cwd } } as unknown as Config
  const rpc = async () =>
    (await readFile(join(cwd, 'rpc.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return { cwd, rpc, adapter: new GrokAdapter(config) }
}

/** Journal réduit à ce que `forkCut` en lit. */
function logWithTurns(kept: number, total: number): EventLog {
  return { countByType: () => ({ kept, total }) } as unknown as EventLog
}

test('catalogue : modèles, efforts du plus bas au plus haut, défauts et commandes, lus par initialize', async (t) => {
  const { adapter, cwd, rpc } = await adapterFixture(t)
  const listing = await adapter.models()
  assert.deepEqual(listing.models, [
    {
      value: 'grok-test', displayName: 'Grok Test', description: 'fixture', hint: 'grok-test', isDefault: true,
      efforts: [{ value: 'low', label: 'Low', hint: null }, { value: 'high', label: 'High', hint: null }],
      defaultEffort: 'high', supportsFastMode: false,
    },
    { value: 'grok-fast', displayName: 'Grok Fast', description: '', hint: 'grok-fast', isDefault: false, efforts: [], defaultEffort: null, supportsFastMode: false },
  ])
  assert.deepEqual(await adapter.resolveDefaults(DEFAULT_GROK_CONFIG), { ...DEFAULT_GROK_CONFIG, model: 'grok-test', reasoningEffort: 'high' })
  assert.deepEqual((await adapter.commands(cwd, false)).commands.map((command) => [command.name, command.argumentHint]), [['compact', ''], ['goal', '<objective>']])
  assert.ok(!(await rpc()).some((entry) => entry.method === 'session/new'), 'le catalogue n’ouvre pas de session')
  assert.equal((await adapter.cli.describe()).version, '1.0.62')
  const usage = await adapter.usage(false)
  assert.equal(usage.plan, 'X Premium', 'la formule vient de `_x.ai/billing`')
  assert.deepEqual(usage.windows.map((window) => [window.id, window.utilization]), [['credits', 0.08]])
})

test('fork : rang du dernier tour gardé, ou toute la session', async (t) => {
  const { adapter, cwd, rpc } = await adapterFixture(t)
  const target = { agentSessionId: 'ses_root', cwd }
  assert.deepEqual(adapter.forkCut(logWithTurns(2, 5), 'c', 10), { targetPromptIndex: 1 })
  assert.deepEqual(adapter.forkCut(logWithTurns(5, 5), 'c', 10), { targetPromptIndex: null })
  assert.throws(() => adapter.forkCut(logWithTurns(0, 3), 'c', 1), ForkError)

  assert.equal(await adapter.fork(target, { targetPromptIndex: 1 }), 'ses_forked')
  assert.equal(await adapter.fork(target, { targetPromptIndex: null }), 'ses_forked')
  const forks = (await rpc()).filter((entry) => entry.method === '_x.ai/session/fork').map((entry) => entry.params)
  assert.deepEqual(forks, [
    { sourceSessionId: 'ses_root', sourceCwd: cwd, newCwd: cwd, targetPromptIndex: 1 },
    { sourceSessionId: 'ses_root', sourceCwd: cwd, newCwd: cwd },
  ])
})

test('outils : noms et champs ramenés à ceux du journal', () => {
  assert.deepEqual(describeTool('read_file', { variant: 'ReadFile', target_file: '/w/a.ts', offset: 3 }), { name: 'Read', input: { file_path: '/w/a.ts', offset: 3 } })
  assert.deepEqual(describeTool('run_terminal_command', { command: 'ls', description: 'List', is_background: false }),
    { name: 'Bash', input: { command: 'ls', description: 'List', run_in_background: false } })
  assert.deepEqual(describeTool('write', { variant: 'Write', file_path: '/w/b.ts', content: 'x' }), { name: 'Write', input: { file_path: '/w/b.ts', content: 'x' } })
  assert.deepEqual(describeTool('use_tool', { tool_name: 'sillage__list_cards', tool_input: { column: 'todo' } }), { name: 'sillage/list_cards', input: { column: 'todo' } })
  assert.deepEqual(describeTool('mystery', { a: 1 }), { name: 'mystery', input: { a: 1 } })
})

test('diff d’un appel : extrait partiel pour une édition, fichier entier pour une création', () => {
  const raw = { diffs: [
    { path: '/w/a.txt', oldText: 'a', newText: 'b' },
    { path: '/w/new.txt', oldText: '', newText: 'hello' },
  ] }
  const edit = describeEdit(raw, '/w', 'a.txt')
  assert.equal(edit.kind, 'patch')
  assert.equal(edit.partial, true)
  assert.match(edit.patch, /^-a$/m)
  assert.match(edit.patch, /^\+b$/m)
  const created = describeEdit(raw, '/w', 'new.txt')
  assert.equal(created.partial, false)
  assert.match(created.patch, /new file mode/)
  assert.equal(describeEdit(null, '/w', 'a.txt').kind, 'unavailable')
})

test('configuration : défauts relus, modes permissifs', () => {
  assert.deepEqual(parseAgentConfig(JSON.stringify({ agent: 'grok', model: '' })), DEFAULT_GROK_CONFIG)
  assert.equal(isPermissiveConfig(DEFAULT_GROK_CONFIG), false)
  assert.equal(isPermissiveConfig({ ...DEFAULT_GROK_CONFIG, permissionMode: 'plan' }), false)
  assert.equal(isPermissiveConfig({ ...DEFAULT_GROK_CONFIG, permissionMode: 'auto' }), true)
  assert.equal(isPermissiveConfig({ ...DEFAULT_GROK_CONFIG, permissionMode: 'bypassPermissions' }), true)
})
