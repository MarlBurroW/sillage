import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cardNotes, cards, conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'

/**
 * Le serveur MCP en mode global : lancé sans projet, au nom d'un compte, par un CLI
 * local branché sur toute l'instance (`docs/mcp.md`). Ce qui passe par le daemon est
 * couvert dans `agent-requests.test.ts` ; ici, la liste d'outils, le choix du projet et
 * les écritures directes.
 */

interface ToolResult {
  content: { text: string }[]
  isError?: boolean
}

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-mcp-global-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: '', createdAt: 1, isAdmin: true }).run()
  for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta app'], ['gamma', 'Beta api']]) {
    db.insert(projects).values({ id, name, workspacePath: join(dir, id), ownerId: 'owner', visibility: 'private', instructionsMode: 'sillage', createdAt: 1 }).run()
  }

  const run = (env: Record<string, string>, requests: object[]) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_MEMORY: join(dir, 'memory'), ...env },
      encoding: 'utf8',
      timeout: 10000,
      input: requests.map((request, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...request })).join('\n') + '\n',
    })
    return result
  }
  const call = (name: string, args: object, env: Record<string, string> = { SILLAGE_MCP_USER: 'owner' }) => {
    const result = run(env, [{ method: 'tools/call', params: { name, arguments: args } }])
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout).result as ToolResult
  }
  return { db, dir, run, call }
}

test('without a project, the server serves the whole instance in the name of one account', async (t) => {
  const { db, run } = await harness(t)

  // Un seul compte : il va de soi. Deux : il faut le nommer.
  assert.equal(run({}, [{ method: 'ping' }]).status, 0)
  db.insert(users).values({ id: 'other', username: 'other', displayName: 'Other', passwordHash: '', createdAt: 2 }).run()
  const ambiguous = run({}, [{ method: 'ping' }])
  assert.equal(ambiguous.status, 1)
  assert.match(ambiguous.stderr, /SILLAGE_MCP_USER/)
  assert.equal(run({ SILLAGE_MCP_USER: 'nobody' }, [{ method: 'ping' }]).status, 1)
  assert.equal(run({ SILLAGE_MCP_USER: 'other' }, [{ method: 'ping' }]).status, 0)
})

test('the global tool list adds list_projects, a project parameter, and drops session-only tools', async (t) => {
  const { run } = await harness(t)
  const listing = run({ SILLAGE_MCP_USER: 'owner' }, [{ method: 'tools/list' }])
  const tools = JSON.parse(listing.stdout).result.tools as { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[]
  const names = tools.map((tool) => tool.name)

  assert.equal(names[0], 'list_projects')
  for (const absent of ['send_session_message', 'broadcast_session_message', 'notify_when_done', 'read_session_messages', 'request_decision']) {
    assert.ok(!names.includes(absent), absent)
  }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(byName.list_cards!.inputSchema.required, ['project'])
  assert.deepEqual(byName.add_card_note!.inputSchema.required, ['project', 'card', 'body'])
  assert.ok(!byName.count_active_sessions!.inputSchema.required)
  assert.ok('project' in byName.read_instructions!.inputSchema.properties)
})

test('each call names its project, by id, name or unambiguous fragment', async (t) => {
  const { db, call } = await harness(t)
  db.insert(conversations).values({
    id: 'c1', projectId: 'alpha', userId: 'owner', title: 'Session', agent: 'claude', config: '{}', status: 'running',
    createdAt: 1, updatedAt: Date.now(),
  }).run()

  const listed = call('list_projects', {}).content[0]!.text
  assert.match(listed, /3 projet\(s\)/)
  assert.match(listed, /Alpha \(id alpha\).*1 session\(s\) en train de travailler/)

  assert.equal(call('list_cards', {}).isError, true)
  assert.equal(call('list_cards', { project: 'nowhere' }).isError, true)
  const ambiguous = call('list_cards', { project: 'beta a' })
  assert.equal(ambiguous.isError, true)
  assert.match(ambiguous.content[0]!.text, /Beta api \(gamma\), Beta app \(beta\)/)
  assert.equal(call('list_cards', { project: 'Beta API' }).isError, undefined)
  assert.equal(call('list_cards', { project: 'gamma' }).isError, undefined)
  assert.match(call('list_sessions', { project: 'alph' }).content[0]!.text, /Session/)

  // Sans projet là où un appel se comprend sans lui.
  assert.match(call('count_active_sessions', {}).content[0]!.text, /1/)
  assert.equal(call('read_instructions', { scope: 'global' }).isError, undefined)
  assert.equal(call('read_instructions', {}).isError, true)
})

test('direct writes carry the account, and the card comes from the call', async (t) => {
  const { db, dir, call } = await harness(t)
  db.insert(cards).values({
    id: 'card', projectId: 'beta', number: 3, title: 'Bug', description: '', column: 'todo',
    position: 1, createdBy: 'owner', createdAt: 1, updatedAt: 1,
  }).run()

  assert.equal(call('add_card_note', { project: 'Beta app', body: 'note' }).isError, true)
  assert.equal(call('add_card_note', { project: 'Beta app', card: 9, body: 'note' }).isError, true)
  const noted = call('add_card_note', { project: 'Beta app', card: 3, body: 'Vu depuis le Mac.' })
  assert.equal(noted.isError, undefined, noted.content[0]?.text)
  const note = db.select().from(cardNotes).get()!
  assert.equal(note.userId, 'owner')
  assert.equal(note.conversationId, null)

  const written = call('write_instructions', { project: 'alpha', content: '# Alpha' })
  assert.equal(written.isError, undefined, written.content[0]?.text)
  assert.match(call('read_instructions', { project: 'alpha' }).content[0]!.text, /# Alpha/)
  assert.equal(call('write_instructions', { scope: 'global', content: '# Tous' }).isError, undefined)

  // La mémoire suit le projet de l'appel, sous la racine donnée.
  assert.equal(call('write_memory', { project: 'alpha', file: 'note.md', content: '---\nname: note\ndescription: x\n---\nx' }).isError, undefined)
  assert.match(call('read_memory', { project: 'alpha' }).content[0]!.text, new RegExp(join(dir, 'memory', 'projects', 'alpha')))
  assert.match(call('read_memory', { project: 'gamma' }).content[0]!.text, /Mémoire vide/)

  const peer = call('send_session_message', { project: 'alpha', to: 'x', body: 'y' })
  assert.equal(peer.isError, true)
  assert.match(peer.content[0]!.text, /hors session/)
})
