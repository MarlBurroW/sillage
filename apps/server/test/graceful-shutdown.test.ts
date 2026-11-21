import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, runMigrations, users } from '@sillage/db'
import { defaultConfigFor } from '@sillage/protocol'
import type { RunnerContext } from '../src/agents/types.js'
import { loadConfig } from '../src/config.js'
import { createPersonalWorkspace } from '../src/conversations/personal-workspaces.js'
import { EventLog } from '../src/events/event-log.js'
import { fakeAdapter, fakeRunner, makeSessionManager } from './session-support.js'

/** Shutdown closes every turn in progress itself, refuses new work, and survives a runner that fails to stop. */

async function until(predicate: () => boolean) {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate())
}

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sillage-shutdown-'))
  const { db, sqlite } = openDatabase(join(root, 'test.db'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'user', username: 'user', displayName: 'User', passwordHash: '', createdAt: 1 }).run()
  const workspace = createPersonalWorkspace(db, root, 'user', 'Test')
  for (const id of ['a', 'b', 'idle']) {
    db.insert(conversations).values({ id, userId: 'user', workspaceId: workspace.id, title: id, status: 'idle', agent: 'codex', config: JSON.stringify(defaultConfigFor('codex')), createdAt: 1, updatedAt: 1 }).run()
  }
  const config = loadConfig()
  config.paths = { ...config.paths, data: root, agents: join(root, 'agents'), memory: join(root, 'memory') }
  const contexts = new Map<string, RunnerContext>()
  const stopped: string[] = []
  const adapter = fakeAdapter('codex', config.paths.agents, (ctx) => {
    contexts.set(ctx.conversationId, ctx)
    return fakeRunner(ctx, {
      async start() {},
      async send() { ctx.setStatus('running') },
      async interrupt() {},
      // The first conversation's CLI refuses to die: the others must still be stopped.
      async stop() {
        stopped.push(ctx.conversationId)
        if (ctx.conversationId === 'a') throw new Error('kill EPERM')
      },
    })
  })
  const log = new EventLog(db)
  const sessions = makeSessionManager({ db, log, config, adapters: [adapter] })
  t.after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }) })
  const deliveries = (sessions as unknown as { pendingDeliveries: Map<string, unknown> }).pendingDeliveries
  const status = (id: string) => db.select().from(conversations).where(eq(conversations.id, id)).get()!.status
  return { sessions, log, contexts, stopped, deliveries, status }
}

test('shutdown marks running turns interrupted itself, and late runner writes cannot undo it', async (t) => {
  const h = await harness(t)
  for (const id of ['a', 'b']) {
    await h.sessions.sendMessage(id, `m-${id}`, 'work')
    await until(() => h.contexts.has(id) && !h.deliveries.has(id))
  }
  // An idle warm runner is stopped too, but its conversation was not interrupted.
  await h.sessions.sendMessage('idle', 'm-idle', 'done')
  await until(() => h.contexts.has('idle') && !h.deliveries.has('idle'))
  h.contexts.get('idle')!.setStatus('idle')

  await h.sessions.stopAll()
  assert.deepEqual(h.stopped.sort(), ['a', 'b', 'idle'], 'a runner failing to stop does not keep the others running')
  assert.equal(h.sessions.activeCount(), 0)
  for (const id of ['a', 'b']) {
    assert.equal(h.status(id), 'interrupted')
    const types = h.log.read(id, 0, 1000).map((entry) => entry.event.type)
    assert.ok(types.includes('error') && types.at(-1) === 'session.ended', types.join(','))
  }
  assert.equal(h.status('idle'), 'idle')

  // Claude's stream ends after stop and used to set idle: the turn then escaped recovery.
  h.contexts.get('a')!.setStatus('idle')
  h.contexts.get('a')!.emit({ type: 'session.ended', reason: 'interrupted' })
  assert.equal(h.status('a'), 'interrupted')
  assert.equal(h.log.read('a', 0, 1000).filter((entry) => entry.event.type === 'session.ended').length, 1)

  // Nothing new starts once shutdown began.
  await assert.rejects(h.sessions.sendMessage('idle', 'late', 'too late'), { code: 'server_stopping' })
})
