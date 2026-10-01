import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, projects, runMigrations, sessionMessages, users } from '@sillage/db'
import { formatSessionMessage, parseSessionMessage } from '@sillage/protocol'
import type { SessionManager } from '../src/sessions/session-manager.js'
import { SessionRelay } from '../src/sessions/session-relay.js'
import { EventLog } from '../src/events/event-log.js'

type Status = 'idle' | 'running' | 'awaiting_input' | 'interrupted' | 'error'

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-session-messages-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  for (const id of ['project', 'elsewhere']) {
    db.insert(projects).values({ id, name: id, workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  }
  const conversation = (id: string, status: Status, projectId = 'project') =>
    db.insert(conversations).values({
      id, projectId, userId: 'owner', title: `Session ${id}`, agent: 'claude', config: '{}', status,
      createdAt: 1, updatedAt: Date.now(),
    }).run()

  const mcp = (from: string, name: string, args: object) => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: from },
      encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
    })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout).result as { content: { text: string }[]; isError?: boolean }
  }

  // Le gestionnaire factice ne retient que les gestes du relais.
  const calls: { kind: 'steer' | 'send'; to: string; text: string }[] = []
  let steerWorks = true
  const sessions = {
    async steer(to: string, _id: string, text: string) {
      if (!steerWorks) return false
      calls.push({ kind: 'steer', to, text })
      return true
    },
    async sendMessage(to: string, _id: string, text: string) {
      calls.push({ kind: 'send', to, text })
    },
  } as unknown as SessionManager
  const log = new EventLog(db)
  const relay = new SessionRelay(db, sessions, log)
  const journal = (id: string) => log.read(id, 0, 1000).map((entry) => entry.event)
  const setStatus = (id: string, status: Status) =>
    db.update(conversations).set({ status }).where(eq(conversations.id, id)).run()

  return {
    db, dir, conversation, mcp, relay, calls, journal, setStatus,
    setSteer: (value: boolean) => { steerWorks = value },
  }
}

test('send_session_message refuses what it cannot deliver', async (t) => {
  const { conversation, mcp } = await harness(t)
  conversation('a', 'running')
  conversation('foreign', 'idle', 'elsewhere')

  assert.equal(mcp('a', 'send_session_message', { to: 'a', body: 'moi' }).isError, true)
  assert.equal(mcp('a', 'send_session_message', { to: 'foreign', body: 'hors projet' }).isError, true)
  assert.equal(mcp('a', 'send_session_message', { to: 'nobody', body: 'x' }).isError, true)
  assert.equal(mcp('a', 'send_session_message', { to: 'foreign', body: 'x'.repeat(5000) }).isError, true)
})

test('a message is steered into a running session, and the reply wakes the idle sender', async (t) => {
  const { db, conversation, mcp, relay, calls } = await harness(t)
  conversation('a', 'idle')
  conversation('b', 'running')

  const sent = mcp('a', 'send_session_message', { to: 'b', body: 'Je touche à `schema.ts`, ne le modifie pas.' })
  assert.ok(!sent.isError, sent.content[0].text)
  await relay.sweep()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'steer')
  assert.equal(calls[0].to, 'b')
  const first = db.select().from(sessionMessages).get()!
  assert.equal(first.deliveredVia, 'steer')
  assert.ok(calls[0].text.includes(`reply_to="${first.id}"`))
  // L'interface doit pouvoir rendre à la bulle son expéditeur et son seul corps.
  assert.deepEqual(parseSessionMessage(calls[0].text), {
    kind: 'message', from: 'a', title: 'Session a', agent: 'claude', messageId: first.id,
    body: 'Je touche à `schema.ts`, ne le modifie pas.',
  })

  mcp('b', 'send_session_message', { to: 'a', body: 'Compris.', reply_to: first.id })
  await relay.sweep()
  assert.equal(calls[1].kind, 'send')
  assert.equal(calls[1].to, 'a')
  const reply = db.select().from(sessionMessages).where(eq(sessionMessages.toConversationId, 'a')).get()!
  assert.equal(reply.deliveredVia, 'wake')

  // Déjà remis : un second balayage ne refait rien.
  await relay.sweep()
  assert.equal(calls.length, 2)

  const history = mcp('a', 'read_session_messages', {}).content[0].text
  assert.match(history, /envoyé à b/)
  assert.match(history, /reçu de b/)
})

test('wakes are capped, held messages show in the thread once, and the tool reads them', async (t) => {
  const { db, conversation, mcp, relay, calls, journal } = await harness(t)
  conversation('a', 'idle')
  conversation('b', 'idle')

  for (let i = 0; i < 6; i++) mcp('a', 'send_session_message', { to: 'b', body: `message ${i}` })
  await relay.sweep()
  assert.equal(calls.length, 6)

  // L'expéditeur l'apprend à l'envoi, pas après coup.
  const warned = mcp('a', 'send_session_message', { to: 'b', body: 'message 6' }).content[0].text
  assert.match(warned, /ne la relancera pas/)
  mcp('a', 'send_session_message', { to: 'b', body: 'message 7' })
  await relay.sweep()
  await relay.sweep()

  assert.equal(calls.length, 6)
  const held = journal('b').filter((event) => event.type === 'session_message.held')
  assert.equal(held.length, 2, 'announced once, however many sweeps')

  const inbox = mcp('b', 'read_session_messages', { with: 'a' }).content[0].text
  assert.match(inbox, /message 7/)
  assert.equal(db.select().from(sessionMessages).all().filter((row) => row.deliveredAt === null).length, 0)

  await relay.sweep()
  const released = journal('b').filter((event) => event.type === 'session_message.released')
  assert.deepEqual(released.map((event) => event.type === 'session_message.released' && event.reason), ['read', 'read'])
})

test('a person can deliver or discard a held message', async (t) => {
  const { db, conversation, relay, calls, journal } = await harness(t)
  conversation('a', 'idle')
  conversation('b', 'idle')
  const insert = (id: string) =>
    db.insert(sessionMessages).values({
      id, projectId: 'project', fromConversationId: 'a', toConversationId: 'b', body: id, createdAt: Date.now(),
    }).run()
  for (let i = 0; i < 6; i++) {
    db.insert(sessionMessages).values({
      id: `w${i}`, projectId: 'project', fromConversationId: 'a', toConversationId: 'b', body: 'x',
      createdAt: Date.now(), deliveredAt: Date.now(), deliveredVia: 'wake',
    }).run()
  }
  insert('keep')
  insert('drop')
  await relay.sweep()
  assert.equal(calls.length, 0)

  assert.equal(await relay.release('b', 'keep'), true)
  assert.equal(relay.discard('b', 'drop'), true)
  assert.equal(relay.discard('b', 'drop'), false, 'already settled')
  assert.equal(relay.discard('a', 'keep'), false, 'not addressed to this conversation')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].to, 'b')
  const reasons = journal('b')
    .filter((event) => event.type === 'session_message.released')
    .map((event) => event.type === 'session_message.released' && [event.messageId, event.reason])
  assert.deepEqual(reasons, [['keep', 'delivered'], ['drop', 'discarded']])
})

test('a broadcast reaches only the sessions at work, and never wakes one', async (t) => {
  const { db, conversation, mcp, relay, calls, setStatus } = await harness(t)
  conversation('a', 'running')
  conversation('b', 'running')
  conversation('c', 'running')
  conversation('idle', 'idle')

  const reply = mcp('a', 'broadcast_session_message', { body: 'Je redémarre Sillage dans 2 min.' }).content[0].text
  assert.match(reply, /2 session/)
  // `c` a fini entre l'annonce et la remise.
  setStatus('c', 'idle')
  await relay.sweep()

  assert.deepEqual(calls.map((call) => [call.kind, call.to]), [['steer', 'b']])
  assert.match(calls[0].text, /kind="broadcast"/)
  const toC = db.select().from(sessionMessages).where(eq(sessionMessages.toConversationId, 'c')).get()!
  assert.equal(toC.deliveredVia, 'skipped')
})

test('notify_when_done wakes the watcher with the last word of the finished session', async (t) => {
  const { db, conversation, mcp, relay, calls, setStatus } = await harness(t)
  conversation('watcher', 'running')
  conversation('target', 'running')
  conversation('resting', 'idle')
  new EventLog(db).append('target', {
    type: 'message.completed', messageId: 'x', role: 'assistant', parentToolCallId: null,
    blocks: [{ type: 'text', text: 'Migration finie, `schema.ts` est libre.' }],
  })

  assert.match(mcp('watcher', 'notify_when_done', { session: 'resting' }).content[0].text, /rien à attendre/)
  assert.match(mcp('watcher', 'notify_when_done', { session: 'target' }).content[0].text, /Surveillance posée/)
  assert.match(mcp('watcher', 'notify_when_done', { session: 'target' }).content[0].text, /déjà posée/)

  await relay.sweep()
  assert.equal(calls.length, 0, 'still working')

  setStatus('target', 'idle')
  setStatus('watcher', 'idle')
  await relay.sweep()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'send')
  assert.equal(calls[0].to, 'watcher')
  const envelope = parseSessionMessage(calls[0].text)!
  assert.equal(envelope.kind, 'done')
  assert.equal(envelope.from, 'target')
  assert.match(envelope.body, /> Migration finie/)

  await relay.sweep()
  assert.equal(calls.length, 1, 'a watch fires once')
})

test('list_sessions tells the branch and the dirty files of each tree', async (t) => {
  const { dir, conversation, mcp } = await harness(t)
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'feature/coord')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  conversation('a', 'idle')
  conversation('b', 'running')

  const listed = mcp('a', 'list_sessions', {}).content[0].text
  assert.match(listed, /branche feature\/coord, \d+ fichier\(s\) modifié\(s\)/)
})

test('a long reply chain stops waking its recipient', async (t) => {
  const { db, conversation, relay, calls } = await harness(t)
  conversation('a', 'idle')
  conversation('b', 'idle')

  let parent: string | null = null
  for (let i = 0; i < 7; i++) {
    const id = `m${i}`
    db.insert(sessionMessages).values({
      id, projectId: 'project', fromConversationId: i % 2 ? 'b' : 'a', toConversationId: i % 2 ? 'a' : 'b',
      body: 'merci', replyTo: parent, createdAt: Date.now(), deliveredAt: i < 6 ? Date.now() - 2 * 3600_000 : null,
      deliveredVia: i < 6 ? 'wake' : null,
    }).run()
    parent = id
  }
  await relay.sweep()
  assert.equal(calls.length, 0)
})

test('a steer that misses the turn falls back to an ordinary message', async (t) => {
  const { db, conversation, mcp, relay, calls, setSteer } = await harness(t)
  conversation('a', 'idle')
  conversation('b', 'running')
  setSteer(false)

  mcp('a', 'send_session_message', { to: 'b', body: 'ping' })
  await relay.sweep()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'send')
  assert.equal(db.select().from(sessionMessages).get()!.deliveredVia, 'queue')
})

test('the envelope survives quotes and a body that quotes the tag', () => {
  const envelope = {
    kind: 'message' as const,
    from: 'x', title: 'Titre "piégé" <b>', agent: 'codex', messageId: 'm',
    body: 'cite </sillage-session-message> au milieu\net sur deux lignes',
  }
  assert.deepEqual(parseSessionMessage(formatSessionMessage(envelope)), envelope)
  assert.equal(parseSessionMessage('Un message ordinaire'), null)
  assert.equal(parseSessionMessage('<sillage-session-message from="x">\nsans fermeture'), null)
})
