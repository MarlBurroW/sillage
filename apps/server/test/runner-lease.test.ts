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

/** A runner's context belongs to that runner: a stopped one must not write over its successor, and one stopped while starting must not survive untracked. */

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate())
}

async function harness(t: TestContext, starts: (index: number) => Promise<void> = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'sillage-runner-lease-'))
  const { db, sqlite } = openDatabase(join(root, 'test.db'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'user', username: 'user', displayName: 'User', passwordHash: '', createdAt: 1 }).run()
  const workspace = createPersonalWorkspace(db, root, 'user', 'Test')
  db.insert(conversations).values({ id: 'c', userId: 'user', workspaceId: workspace.id, title: 'Test', status: 'idle', agent: 'codex', config: JSON.stringify(defaultConfigFor('codex')), createdAt: 1, updatedAt: 1 }).run()
  const config = loadConfig()
  config.paths = { ...config.paths, data: root, agents: join(root, 'agents'), memory: join(root, 'memory') }
  const contexts: RunnerContext[] = []
  let stops = 0
  const adapter = fakeAdapter('codex', config.paths.agents, (ctx) => {
    const index = contexts.push(ctx) - 1
    return fakeRunner(ctx, {
      async start() { await starts(index) },
      async send() { ctx.setStatus('running') },
      async interrupt() {},
      async stop() { stops++ },
    })
  })
  const log = new EventLog(db)
  const sessions = makeSessionManager({ db, log, config, adapters: [adapter] })
  t.after(async () => { await sessions.stopAll(); sqlite.close(); await rm(root, { recursive: true, force: true }) })
  const status = () => db.select().from(conversations).where(eq(conversations.id, 'c')).get()!.status
  const deliveries = (sessions as unknown as { pendingDeliveries: Map<string, unknown> }).pendingDeliveries
  return { sessions, log, contexts, status, deliveries, stops: () => stops }
}

test('a stopped runner that unwinds late cannot end its successor’s turn', async (t) => {
  const h = await harness(t)
  await h.sessions.sendMessage('c', 'first', 'hello')
  await until(() => h.contexts.length === 1 && !h.deliveries.has('c'))
  h.contexts[0]!.setStatus('idle')

  // The runner is replaced, as a configuration restart or a CLI update does.
  const release = await h.sessions.prepareCliUpdate('codex')
  assert.ok(release)
  release()
  await h.sessions.sendMessage('c', 'second', 'again')
  await until(() => h.contexts.length === 2 && !h.deliveries.has('c'))
  assert.equal(h.status(), 'running')
  const before = h.log.read('c', 0, 1000).length

  // The first runner's stream ends only now: its epilogue must not reach the new turn.
  h.contexts[0]!.emit({ type: 'session.ended', reason: 'interrupted' })
  h.contexts[0]!.setStatus('idle')
  h.contexts[0]!.setAgentSessionId('stale-session')
  assert.equal(h.status(), 'running')
  assert.equal(h.log.read('c', 0, 1000).length, before, 'nothing journaled by the stopped runner')

  // The live runner still writes normally.
  h.contexts[1]!.setStatus('idle')
  assert.equal(h.status(), 'idle')
})

test('a runner stopped while its CLI starts is stopped, not left running untracked', async (t) => {
  const gate = deferred()
  const h = await harness(t, async (index) => { if (index === 0) await gate.promise })
  await h.sessions.sendMessage('c', 'first', 'hello')
  await until(() => h.contexts.length === 1)

  // Stopped mid-start, as a deletion or an eviction does.
  await h.sessions.terminate('c')
  gate.resolve()
  await until(() => !h.deliveries.has('c'))

  assert.equal(h.stops(), 2, 'stopped by terminate, then again once its start returned')
  assert.equal(h.sessions.activeCount(), 0)
  // The stop explains the outcome: the turn is closed as interrupted, not as a failed send.
  const events = h.log.read('c', 0, 1000).map((entry) => entry.event)
  assert.equal(events.some((event) => event.type === 'error' && event.code === 'send_failed'), false)
  assert.equal(events.filter((event) => event.type === 'turn.completed' && event.stopReason === 'interrupted').length, 1)
  assert.equal(h.status(), 'interrupted')
})
