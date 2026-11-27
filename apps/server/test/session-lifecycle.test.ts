import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { conversations, openDatabase, permissionRequests, runMigrations, users } from '@sillage/db'
import { defaultConfigFor, type ConversationStatus, type SillageEvent } from '@sillage/protocol'
import type { RunnerContext } from '../src/agents/types.js'
import { loadConfig } from '../src/config.js'
import { createPersonalWorkspace } from '../src/conversations/personal-workspaces.js'
import { EventLog } from '../src/events/event-log.js'
import { fakeAdapter, fakeRunner, makeSessionManager } from './session-support.js'

/** A conversation's life on a real SessionManager: recovery, sends, queue, stops, reaping and eviction. */

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(predicate: () => boolean, message?: string) {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate(), message)
}

interface Fake {
  ctx: RunnerContext
  sends: string[]
  interrupts: number
  stops: number
}

async function harness(t: TestContext, rows: Record<string, ConversationStatus>, options: { limit?: number; idleMin?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sillage-lifecycle-'))
  const { db, sqlite } = openDatabase(join(root, 'test.db'))
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'user', username: 'user', displayName: 'User', passwordHash: '', createdAt: 1 }).run()
  const workspace = createPersonalWorkspace(db, root, 'user', 'Test')
  for (const [id, status] of Object.entries(rows)) {
    db.insert(conversations).values({ id, userId: 'user', workspaceId: workspace.id, title: id, status, agent: 'codex', config: JSON.stringify(defaultConfigFor('codex')), createdAt: 1, updatedAt: 1 }).run()
  }
  const config = loadConfig()
  config.paths = { ...config.paths, data: root, agents: join(root, 'agents'), memory: join(root, 'memory') }
  config.limits = { ...config.limits, maxConcurrentSessions: options.limit ?? 10, sessionIdleTimeoutMin: options.idleMin ?? 30 }
  const runners = new Map<string, Fake>()
  /** Set per conversation to hold its CLI start, or make it fail. */
  const starts = new Map<string, () => Promise<void>>()
  /** Conversations whose CLI is gone: interrupting it rejects, like the Claude SDK after its process died. */
  const dead = new Set<string>()
  const adapter = fakeAdapter('codex', config.paths.agents, (ctx) => {
    const fake: Fake = { ctx, sends: [], interrupts: 0, stops: 0 }
    runners.set(ctx.conversationId, fake)
    return fakeRunner(ctx, {
      async start() { await starts.get(ctx.conversationId)?.() },
      async send(text: string) { fake.sends.push(text); ctx.setStatus('running') },
      async interrupt() {
        fake.interrupts++
        if (dead.has(ctx.conversationId)) throw new Error('Query closed before response received')
      },
      async stop() { fake.stops++ },
    })
  })
  const log = new EventLog(db)
  const sessions = makeSessionManager({ db, log, config, adapters: [adapter] })
  t.after(async () => { await sessions.stopAll(); sqlite.close(); await rm(root, { recursive: true, force: true }) })
  const deliveries = (sessions as unknown as { pendingDeliveries: Map<string, unknown> }).pendingDeliveries
  const row = (id: string) => db.select().from(conversations).where(eq(conversations.id, id)).get()!
  const events = (id: string): SillageEvent[] => log.read(id, 0, 10_000).map((entry) => entry.event)
  const types = (id: string) => events(id).map((event) => event.type)
  /** Sends and waits until the CLI has the message and runs its turn. */
  const run = async (id: string, clientMessageId: string, text = 'work') => {
    await sessions.sendMessage(id, clientMessageId, text)
    await until(() => !deliveries.has(id))
  }
  return { db, log, sessions, runners, starts, dead, deliveries, row, events, types, run, workspace }
}

test('restart recovery interrupts open turns, closes what they left open, and spares idle conversations', async (t) => {
  const h = await harness(t, { run: 'running', wait: 'awaiting_input', bg: 'idle', calm: 'idle' })
  const task = { id: 'dev-server', kind: 'shell', description: 'npm run dev' }
  h.log.append('run', { type: 'message.queued', queueId: 'q1', text: 'later', attachmentCount: 0 })
  h.log.append('run', { type: 'background.updated', tasks: [task] })
  h.log.append('wait', { type: 'permission.requested', requestId: 'p1', toolName: 'Bash', input: { command: 'ls' }, suggestions: [] })
  h.db.insert(permissionRequests).values({ id: 'p1', conversationId: 'wait', seq: 1, toolName: 'Bash', input: '{}', status: 'pending', decisionScope: null, decidedBy: null, createdAt: 1, decidedAt: null }).run()
  h.log.append('bg', { type: 'background.updated', tasks: [task] })
  h.db.update(conversations).set({ backgroundCount: 1 }).where(eq(conversations.id, 'bg')).run()

  assert.deepEqual(h.sessions.recoverInterrupted().sort(), ['run', 'wait'])

  for (const id of ['run', 'wait']) {
    assert.equal(h.row(id).status, 'interrupted')
    assert.equal(h.types(id).at(-1), 'session.ended')
    assert.ok(h.events(id).some((event) => event.type === 'error' && event.code === 'daemon_restarted'))
  }
  assert.ok(h.events('run').some((event) => event.type === 'message.dequeued' && event.queueId === 'q1' && event.reason === 'expired'))
  assert.ok(h.events('run').some((event) => event.type === 'task.completed' && event.taskId === 'dev-server'))
  assert.ok(h.events('wait').some((event) => event.type === 'permission.resolved' && event.decision === 'expired'))
  assert.equal(h.db.select().from(permissionRequests).get()?.status, 'expired')

  // The dev server died with the daemon, but its conversation was not interrupted mid-turn.
  assert.equal(h.row('bg').status, 'idle')
  assert.ok(h.events('bg').some((event) => event.type === 'task.completed' && event.taskId === 'dev-server'))
  assert.equal(h.types('bg').includes('error'), false)
  assert.equal(h.row('bg').backgroundCount, 0)
  assert.deepEqual(h.types('calm'), [])

  // Run again, as the next start would: nothing is closed twice.
  const before = h.types('run').length
  assert.deepEqual(h.sessions.recoverInterrupted(), [])
  assert.equal(h.types('run').length, before)
})

test('a resent client message id is delivered once, and becomes sendable again when delivery fails', async (t) => {
  const h = await harness(t, { c: 'idle', f: 'idle' })
  await h.sessions.sendMessage('c', 'm1', 'hello')
  await h.sessions.sendMessage('c', 'm1', 'hello')
  await until(() => !h.deliveries.has('c'))
  assert.deepEqual(h.runners.get('c')!.sends, ['hello'])
  assert.equal(h.events('c').filter((event) => event.type === 'message.completed' && event.role === 'user').length, 1)
  assert.equal(h.types('c').includes('message.queued'), false, 'a duplicate is dropped, not queued')

  // The CLI fails to start: the message did not reach it, so the client's retry must go through.
  h.starts.set('f', async () => { throw new Error('spawn ENOENT') })
  await h.run('f', 'm1')
  assert.ok(h.events('f').some((event) => event.type === 'error' && event.code === 'send_failed'))
  assert.equal(h.events('f').at(-1)?.type, 'turn.completed', 'the turn opened for the message is closed, or the thread shows it running forever')
  assert.equal(h.row('f').status, 'idle')
  h.starts.delete('f')
  await h.run('f', 'm1')
  assert.deepEqual(h.runners.get('f')!.sends, ['work'])
})

test('a CLI dying between its start and the hand-over fails the send instead of leaving a turn no process closes', async (t) => {
  const h = await harness(t, { c: 'idle' })
  const gate = deferred()
  const manager = h.sessions as unknown as { openCheckpoint: (conversation: unknown) => Promise<void>; startingRunners: Map<string, unknown> }
  manager.openCheckpoint = () => gate.promise
  await h.sessions.sendMessage('c', 'm1', 'never sent')
  // Started, not starting: a stop during the start is another, already handled, path.
  await until(() => h.sessions.isWarm('c') && !manager.startingRunners.has('c'))

  // What a runner does when its stream throws: `error` makes the manager stop it.
  h.runners.get('c')!.ctx.setStatus('error')
  await until(() => !h.sessions.isWarm('c'))
  gate.resolve()
  await until(() => !h.deliveries.has('c'))

  assert.deepEqual(h.runners.get('c')!.sends, [])
  assert.ok(h.events('c').some((event) => event.type === 'error' && event.code === 'send_failed'))
  assert.equal(h.row('c').status, 'idle')
  assert.equal(h.events('c').at(-1)?.type, 'turn.completed', 'the thread no longer shows the turn running')
})

test('a missing working directory fails the send with a clear error before any CLI starts', async (t) => {
  const h = await harness(t, { c: 'idle' })
  await rm(h.workspace.path, { recursive: true, force: true })
  await h.run('c', 'm1')

  assert.equal(h.runners.has('c'), false)
  const failure = h.events('c').find((event) => event.type === 'error' && event.code === 'send_failed')
  assert.ok(failure?.type === 'error' && failure.message.includes(`${h.workspace.path} does not exist`))
  assert.equal(h.row('c').status, 'idle')
  assert.equal(h.events('c').at(-1)?.type, 'turn.completed', 'the thread no longer shows the turn running')
})

test('a message sent during a turn waits for its end, then leaves alone', async (t) => {
  const h = await harness(t, { c: 'idle' })
  await h.run('c', 'a', 'first')
  await h.sessions.sendMessage('c', 'b', 'second')
  await h.sessions.sendMessage('c', 'c', 'third')
  assert.deepEqual(h.runners.get('c')!.sends, ['first'])
  assert.equal(h.types('c').filter((type) => type === 'message.queued').length, 2)

  h.runners.get('c')!.ctx.setStatus('idle')
  await until(() => h.runners.get('c')!.sends.length === 2)
  assert.deepEqual(h.runners.get('c')!.sends, ['first', 'second'], 'one queued message per turn')
  h.runners.get('c')!.ctx.setStatus('idle')
  await until(() => h.runners.get('c')!.sends.length === 3)
})

test('Stop during a cold start closes the turn at once and the message never reaches the CLI', async (t) => {
  const h = await harness(t, { c: 'idle' })
  const gate = deferred()
  h.starts.set('c', () => gate.promise)
  await h.sessions.sendMessage('c', 'm1', 'never sent')
  await until(() => h.runners.has('c'))

  await h.sessions.interrupt('c')
  assert.equal(h.row('c').status, 'idle', 'Stop takes effect before the CLI is up')
  assert.ok(h.events('c').some((event) => event.type === 'turn.completed' && event.stopReason === 'interrupted'))
  // Written after Stop while the start still runs: it waits, then goes once the start is over.
  await h.sessions.sendMessage('c', 'm2', 'after stop')
  assert.ok(h.types('c').includes('message.queued'))

  gate.resolve()
  await until(() => h.runners.get('c')!.sends.length === 1)
  assert.deepEqual(h.runners.get('c')!.sends, ['after stop'])
  assert.equal(h.runners.get('c')!.interrupts, 0, 'no turn existed to interrupt')
  assert.equal(h.sessions.activeCount(), 1, 'the CLI stays warm for the next message')
})

test('shutdown during a cold start closes the turn and stops the CLI instead of handing it the message', async (t) => {
  const h = await harness(t, { c: 'idle' })
  const gate = deferred()
  h.starts.set('c', () => gate.promise)
  await h.sessions.sendMessage('c', 'm1', 'never sent')
  await until(() => h.runners.has('c'))

  const stopping = h.sessions.stopAll()
  gate.resolve()
  await stopping
  await until(() => !h.deliveries.has('c'))
  assert.equal(h.row('c').status, 'interrupted')
  assert.deepEqual(h.runners.get('c')!.sends, [])
  assert.equal(h.sessions.activeCount(), 0)
  assert.equal(h.types('c').filter((type) => type === 'session.ended').length, 1)
})

test('terminate stops a running turn and its CLI, and expires what was queued', async (t) => {
  const h = await harness(t, { c: 'idle' })
  await h.run('c', 'a')
  await h.sessions.sendMessage('c', 'b', 'queued')
  await h.sessions.terminate('c')
  const fake = h.runners.get('c')!
  assert.equal(fake.interrupts, 1)
  assert.equal(fake.stops, 1)
  assert.equal(h.sessions.activeCount(), 0)
  assert.equal(h.row('c').status, 'interrupted')
  assert.ok(h.events('c').some((event) => event.type === 'message.dequeued' && event.reason === 'expired'))
})

test('the idle reaper stops quiet CLIs and spares turns and background work', async (t) => {
  // 30 ms of inactivity.
  const h = await harness(t, { quiet: 'idle', busy: 'idle', bg: 'idle' }, { idleMin: 0.0005 })
  for (const id of ['quiet', 'busy', 'bg']) await h.run(id, `m-${id}`)
  h.runners.get('quiet')!.ctx.setStatus('idle')
  h.runners.get('bg')!.ctx.emit({ type: 'background.updated', tasks: [{ id: 'dev', kind: 'shell', description: 'npm run dev' }] })
  h.runners.get('bg')!.ctx.setStatus('idle')

  await until(() => !h.sessions.isWarm('quiet'), 'the quiet CLI is reaped')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(h.sessions.isWarm('busy'), true, 'a turn in progress keeps its CLI')
  assert.equal(h.sessions.isWarm('bg'), true, 'a dev server keeps its CLI')
})

test('at the session limit the oldest quiet CLI without detached work makes room, and busy ones never do', async (t) => {
  const h = await harness(t, { old: 'idle', recent: 'idle', next: 'idle', last: 'idle' }, { limit: 2 })
  await h.run('old', 'a')
  h.runners.get('old')!.ctx.emit({ type: 'background.updated', tasks: [{ id: 'dev', kind: 'shell', description: 'npm run dev' }] })
  h.runners.get('old')!.ctx.setStatus('idle')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await h.run('recent', 'b')
  h.runners.get('recent')!.ctx.setStatus('idle')

  await h.run('next', 'c')
  assert.equal(h.sessions.isWarm('old'), true, 'the older CLI hosts a dev server: the other one goes first')
  assert.equal(h.sessions.isWarm('recent'), false)
  assert.equal(h.sessions.isWarm('next'), true)

  // Everyone is working now: refuse rather than cut a turn.
  await h.sessions.sendMessage('old', 'd', 'more')
  await until(() => !h.deliveries.has('old'))
  await h.run('last', 'e')
  assert.ok(h.events('last').some((event) => event.type === 'error' && event.code === 'send_failed'))
  assert.equal(h.sessions.isWarm('old') && h.sessions.isWarm('next'), true)
})

test('transcript resync never stops a quiet CLI that still hosts background work', async (t) => {
  const h = await harness(t, { build: 'idle' })
  await h.run('build', 'a')
  h.runners.get('build')!.ctx.emit({ type: 'background.updated', tasks: [{ id: 'stage', kind: 'local_bash', description: 'release build' }] })
  h.runners.get('build')!.ctx.setStatus('idle')

  // Between turns the CLI looks idle, but stopping it would kill the build it carries.
  assert.equal(await h.sessions.releaseRunner('build'), false)
  assert.equal(h.sessions.isWarm('build'), true)
  assert.equal(h.runners.get('build')!.stops, 0)

  h.runners.get('build')!.ctx.emit({ type: 'background.updated', tasks: [] })
  assert.equal(await h.sessions.releaseRunner('build'), true)
  assert.equal(h.sessions.isWarm('build'), false)
})

test('evicting a CLI with background work at the session limit says so in its thread', async (t) => {
  const h = await harness(t, { old: 'idle', next: 'idle' }, { limit: 1 })
  await h.run('old', 'a')
  h.runners.get('old')!.ctx.emit({ type: 'background.updated', tasks: [{ id: 'dev', kind: 'shell', description: 'npm run dev' }] })
  h.runners.get('old')!.ctx.setStatus('idle')

  await h.run('next', 'b')
  assert.equal(h.sessions.isWarm('old'), false)
  const tail = h.events('old').slice(-3)
  assert.equal(tail[0]?.type, 'task.completed')
  assert.deepEqual(tail.at(-1), {
    type: 'agent.notice',
    code: 'detached_work_evicted',
    message: 'The concurrent session limit (1) was reached: Sillage stopped this CLI and its background tasks.',
    level: 'warning',
    details: { limit: 1 },
  })
})

test('Stop closes a turn left open when no CLI can answer it', async (t) => {
  const h = await harness(t, { orphan: 'running', dying: 'idle' })
  // A turn whose CLI went away without closing it.
  h.log.append('orphan', { type: 'turn.started' })
  await h.sessions.interrupt('orphan')
  assert.equal(h.events('orphan').at(-1)?.type, 'turn.completed')
  assert.equal(h.row('orphan').status, 'idle')

  // A live runner whose CLI has died: its interrupt rejects, Stop still ends the turn.
  await h.run('dying', 'm1')
  h.dead.add('dying')
  await h.sessions.interrupt('dying')
  assert.equal(h.runners.get('dying')!.interrupts, 1)
  assert.ok(h.events('dying').some((event) => event.type === 'turn.completed' && event.stopReason === 'interrupted'))
  assert.equal(h.row('dying').status, 'idle')
  assert.equal(h.sessions.activeCount(), 0, 'the dead runner no longer holds a slot')
})
