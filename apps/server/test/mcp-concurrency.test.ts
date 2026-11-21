import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cards, conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'

/** One MCP process serves several calls at once: a slow one no longer holds the others, and each keeps its own project. */
test('a slow tool call does not delay the next one, and concurrent calls keep their own project', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-mcp-concurrency-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) {
    db.insert(projects).values({ id, name, workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
    db.insert(cards).values({ id: `card-${id}`, projectId: id, number: 1, title: `Card of ${name}`, description: '', column: 'todo', position: 0, createdBy: 'owner', createdAt: 1, updatedAt: 1 }).run()
  }
  db.insert(conversations).values({ id: 'conv', projectId: 'alpha', userId: 'owner', title: 'c', agent: 'claude', config: '{}', status: 'running', createdAt: 1, updatedAt: 1 }).run()

  // Global mode, as the HTTP bridge runs it: each call names its project.
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
    env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_USER: 'owner', SILLAGE_MCP_REQUEST_WAIT_MS: '3000', SILLAGE_MCP_PROJECT: '' },
  })
  t.after(() => child.kill())
  const replies = new Map<number, { at: number; text: string }>()
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const message = JSON.parse(line) as { id: number; result: { content: { text: string }[] } }
    replies.set(message.id, { at: Date.now(), text: message.result.content.map((part) => part.text).join('\n') })
  })
  const call = (id: number, name: string, args: object) =>
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)

  const started = Date.now()
  // Waits up to 3 s for a daemon that never answers.
  call(1, 'update_card', { project: 'Alpha', number: 1, title: 'Renamed while nobody listens' })
  // Two quick reads on different projects, sent right behind it.
  call(2, 'list_cards', { project: 'Beta' })
  call(3, 'list_cards', { project: 'Alpha' })

  for (let i = 0; i < 200 && replies.size < 3; i++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(replies.size, 3, 'every call answered')
  assert.ok(replies.get(2)!.at - started < 2000, 'the quick read did not wait for the slow call')
  assert.ok(replies.get(2)!.at < replies.get(1)!.at, 'the quick read answered first')
  assert.match(replies.get(2)!.text, /Card of Beta/)
  assert.doesNotMatch(replies.get(2)!.text, /Card of Alpha/)
  assert.match(replies.get(3)!.text, /Card of Alpha/)
})
