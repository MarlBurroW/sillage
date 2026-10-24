import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { sessionMentionAt, sessionReference, sessionReferenceRanges } from '@sillage/protocol'
import { sessionReferenceContext } from '../src/conversations/references.js'
import { describeOutgoingMessage } from '../src/agents/outgoing.js'
import { EventLog } from '../src/events/event-log.js'

const id = '11111111-1111-4111-8111-111111111111'
const project = '22222222-2222-4222-8222-222222222222'
const foreign = '33333333-3333-4333-8333-333333333333'
const missing = '44444444-4444-4444-8444-444444444444'
const origin = 'https://sillage.example'

test('session references distinguish explicit citations, bare IDs and same-instance URLs', () => {
  const text = `See (${sessionReference(id)}), then ${id}. ${origin}/p/${project}/c/${id}?message=1.`
  const refs = sessionReferenceRanges(text, origin)
  assert.equal(refs.length, 3)
  assert.deepEqual(refs.map(ref => ref.id), [id, id, id])
  assert.deepEqual(refs.map(ref => ref.explicit), [true, false, true])
  assert.equal(refs[2]!.projectId, project)
  assert.equal(text.slice(refs[0]!.start, refs[0]!.end), sessionReference(id))
  for (const value of [
    `https://foreign.example/p/${project}/c/${id}`,
    `https://sillage.example.evil/p/${project}/c/${id}`,
    `https://sillage.example@evil/p/${project}/c/${id}`,
    `https://foreign.example/${id}`,
    `prefix${id}`, `${id}suffix`, `/tmp/${id}`, `/p/${project}/c/${id}suffix`,
  ]) assert.deepEqual(sessionReferenceRanges(value, origin), [], value)
  assert.equal(sessionReferenceRanges(`${origin}:443/p/${project}/c/${id}`, origin).length, 1)
  assert.equal(sessionReferenceRanges(`/p/${project}/c/${id}`).length, 1)
})

test('session completion supports multiword titles and respects file/email boundaries', () => {
  const text = 'Ask @@refonte des réglages'
  assert.deepEqual(sessionMentionAt(text, text.length), { query: 'refonte des réglages', start: 4, end: text.length })
  assert.deepEqual(sessionMentionAt('@@', 2), { query: '', start: 0, end: 2 })
  for (const value of ['@src/main.ts', 'user@@host', '@@query\nnext', 'email@example.com']) {
    assert.equal(sessionMentionAt(value, value.length), null, value)
  }
})

test('session context and MCP share exact IDs, archives and project isolation without replaying history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-session-references-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  for (const projectId of [project, 'other']) db.insert(projects).values({
    id: projectId, name: projectId, workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1,
  }).run()
  for (const [sessionId, projectId, title] of [[id, project, 'Archived decision'], [foreign, 'other', 'Private foreign title']]) {
    db.insert(conversations).values({
      id: sessionId!, projectId: projectId!, title: title!, userId: 'owner', agent: 'claude',
      config: '{}', status: 'idle', archivedAt: 2, createdAt: 1, updatedAt: 1,
    }).run()
  }
  const log = new EventLog(db)
  log.append(id, { type: 'message.completed', messageId: 'msg', role: 'assistant', blocks: [{ type: 'text', text: 'Unique archived decision transcript' }], parentToolCallId: null })
  const text = `Compare ${sessionReference(id)} ${id} ${sessionReference(foreign)} ${sessionReference(missing)}`
  const context = sessionReferenceContext(db, project, text, origin, true)!
  assert.equal(context.split('title:').length, 2)
  assert.match(context, /Archived decision/)
  assert.match(context, /archived/)
  assert.match(context, /read_conversation/)
  assert.doesNotMatch(context, /Private foreign title|Unique archived decision transcript/)
  assert.equal(sessionReferenceContext(db, project, foreign, origin, true), null)
  assert.match(sessionReferenceContext(db, project, sessionReference(id), origin, false)!, /tools are disabled/)
  const outgoing = describeOutgoingMessage(text, [], context)
  assert.deepEqual(outgoing.blocks, [{ type: 'text', text }])
  assert.ok(outgoing.promptText.includes(context))

  const call = (name: string, args: object) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: project, SILLAGE_MCP_CONVERSATION: 'reader' },
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout).result as { content: { text: string }[]; isError?: boolean }
  }
  const search = call('search_history', { query: 'Unique archived decision' }).content[0]!.text
  assert.ok(search.includes(sessionReference(id)), search)
  assert.match(search, /archived/)
  const read = call('read_conversation', { id: sessionReference(id) })
  assert.ok(!read.isError, JSON.stringify(read))
  assert.match(read.content[0]!.text, /Unique archived decision transcript/)
  const denied = call('read_conversation', { id: sessionReference(foreign) })
  assert.ok(denied.isError)
  assert.doesNotMatch(denied.content[0]!.text, /Private foreign title/)
})
