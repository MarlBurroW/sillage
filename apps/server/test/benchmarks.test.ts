import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JournalEntry, SillageEvent } from '@sillage/protocol'
import { computeRunMetrics, readWaitingMs, RUN_METRICS_VERSION, upgradeSnapshot } from '../src/benchmarks/metrics.js'
import { EventLog } from '../src/events/event-log.js'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { deliverableKind, BENCHMARK_PREVIEW_PREFIX } from '@sillage/protocol'
import { listDeliverables, previewType } from '../src/benchmarks/deliverables.js'
import type { BenchmarkRunner } from '../src/benchmarks/runner.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerBenchmarkRoutes } from '../src/http/routes/benchmarks.js'
import { runScript } from '../src/scheduler/check.js'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { benchmarkRuns, benchmarks as benchmarkTable, conversations, events, openDatabase, runMigrations, users } from '@sillage/db'
import { BenchmarkRunner, benchmarkInputDir } from '../src/benchmarks/runner.js'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../src/http/context.js'

/** Journal entries at the given millisecond offsets, in order. */
function journal(steps: [number, SillageEvent][]): JournalEntry[] {
  return steps.map(([ts, event], index) => ({ conversationId: 'c', seq: index + 1, ts: 1_000_000 + ts, event }))
}

test('benchmark metrics: durations count working time from the user message, tokens add up across turns', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'session.started', agent: 'claude', agentSessionId: 's', model: 'claude-sonnet-5-5', cwd: '/tmp', tools: [] }],
    // Startup time before the user message is Sillage's, not the model's.
    [1500, { type: 'message.started', messageId: 'u1', role: 'user' }],
    [1500, { type: 'message.completed', messageId: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hello' }], parentToolCallId: null }],
    [1600, { type: 'turn.started' }],
    [2300, { type: 'message.started', messageId: 'a1', role: 'assistant' }],
    [2300, { type: 'message.delta', messageId: 'a1', text: 'Let me', parentToolCallId: null }],
    [2400, { type: 'tool.started', toolCallId: 't1', name: 'Read', input: {}, parentToolCallId: null }],
    [2900, { type: 'tool.completed', toolCallId: 't1', output: 'x', isError: false, durationMs: 500 }],
    [3000, { type: 'tool.started', toolCallId: 't2', name: 'Bash', input: {}, parentToolCallId: null }],
    [3200, { type: 'tool.completed', toolCallId: 't2', output: 'boom', isError: true, durationMs: 200 }],
    [3300, { type: 'tool.started', toolCallId: 't3', name: 'Read', input: {}, parentToolCallId: 't2' }],
    [3400, { type: 'tool.completed', toolCallId: 't3', output: 'y', isError: false, durationMs: 100 }],
    [4000, { type: 'message.completed', messageId: 'a1', role: 'assistant', blocks: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Let me look.' }], parentToolCallId: null }],
    [4100, { type: 'message.completed', messageId: 'a2', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }], parentToolCallId: null }],
    [4200, { type: 'usage.updated', costUsd: 0.01, inputTokens: 10, outputTokens: 20, context: { usedTokens: 1234, maxTokens: 200000, ratio: 0.006 } }],
    [4500, { type: 'turn.completed', stopReason: 'end_turn', costUsd: 0.01, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 300 }],
    [9000, { type: 'message.started', messageId: 'u2', role: 'user' }],
    [9500, { type: 'turn.completed', stopReason: 'end_turn', costUsd: 0.02, inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 400 }],
  ]))

  // The idle gap between the turns (4.5 s to 9 s) is on the wall, not on the clock.
  assert.equal(metrics.durationMs, 3500)
  assert.equal(metrics.elapsedMs, 8000)
  assert.equal(metrics.firstTextMs, 800)
  assert.equal(metrics.inputTokens, 716)
  assert.equal(metrics.outputTokens, 22)
  assert.equal(metrics.cacheCreationTokens, 5)
  assert.equal(metrics.cacheReadTokens, 700)
  assert.ok(Math.abs((metrics.costUsd ?? 0) - 0.03) < 1e-9)
  assert.equal(metrics.toolCalls, 3)
  assert.deepEqual(metrics.toolsByName, { Read: 2, Bash: 1 })
  assert.equal(metrics.toolErrors, 1)
  assert.equal(metrics.toolDurationMs, 800)
  assert.equal(metrics.assistantMessages, 2)
  // Reasoning text is not output.
  assert.equal(metrics.outputChars, 'Let me look.'.length + 'Done.'.length)
  assert.equal(metrics.contextTokens, 1234)
  assert.equal(metrics.model, 'claude-sonnet-5-5')
})

test('benchmark metrics: a CLI that reports no usage yields nulls, never zeros', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'message.started', messageId: 'u1', role: 'user' }],
    [700, { type: 'message.completed', messageId: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }], parentToolCallId: null }],
    [800, { type: 'turn.completed', stopReason: 'end_turn', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
  ]))
  assert.equal(metrics.durationMs, 800)
  assert.equal(metrics.firstTextMs, 700)
  assert.equal(metrics.inputTokens, null)
  assert.equal(metrics.outputTokens, null)
  assert.equal(metrics.costUsd, null)
  assert.equal(metrics.contextTokens, null)
  assert.equal(metrics.model, null)
  assert.equal(metrics.toolCalls, 0)
})

test('benchmark metrics: an interrupted run has no duration but keeps what it consumed', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'message.started', messageId: 'u1', role: 'user' }],
    [500, { type: 'tool.started', toolCallId: 't1', name: 'Bash', input: {}, parentToolCallId: null }],
    [900, { type: 'error', code: 'benchmark_timeout', message: 'cut', recoverable: true }],
    [900, { type: 'session.ended', reason: 'interrupted' }],
  ]))
  assert.equal(metrics.durationMs, null)
  assert.equal(metrics.firstTextMs, null)
  assert.equal(metrics.toolCalls, 1)
  assert.equal(metrics.toolDurationMs, 0)
})

// --- Deliverables, preview route and check script ------------------------------------------

function runFolder(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'sillage-bench-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'assets'))
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<h1>OK</h1><script src="assets/app.js"></script>')
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'assets', 'clip.mp4'), Buffer.alloc(1000, 1))
  writeFileSync(join(root, 'notes.md'), '# notes')
  writeFileSync(join(root, '.hidden'), 'cli state')
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
  return root
}

test('benchmark deliverables: tooling and hidden files are left out, top level first', async (t) => {
  const root = runFolder(t)
  const files = await listDeliverables(root)
  assert.deepEqual(files.map((file) => [file.path, file.kind]), [
    ['index.html', 'page'],
    ['notes.md', 'text'],
    ['assets/app.js', 'text'],
    ['assets/clip.mp4', 'video'],
  ])
  assert.equal(files.find((file) => file.path === 'assets/clip.mp4')?.sizeBytes, 1000)
  assert.equal((await listDeliverables(root, 2)).length, 2)
  assert.equal(deliverableKind('photo.JPG'), 'image')
  assert.equal(deliverableKind('voice.ogg'), 'audio')
  assert.equal(deliverableKind('archive.zip'), 'other')
  assert.equal(previewType('a/b.css'), 'text/css; charset=utf-8')
  assert.equal(previewType('main.rs'), 'text/plain; charset=utf-8')
  assert.equal(previewType('blob.bin'), 'application/octet-stream')
})

test('benchmark preview route: sandboxed, token-scoped, confined to the run folder', async (t) => {
  const root = runFolder(t)
  const outside = mkdtempSync(join(tmpdir(), 'sillage-bench-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'secret.txt'), 'nope')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))

  const app = Fastify()
  registerErrorHandler(app)
  const runner = { previewRoot: (token: string) => (token === 'good-token' ? root : null) } as unknown as BenchmarkRunner
  registerBenchmarkRoutes(app, { db: undefined as never, config: undefined as never }, runner)
  t.after(() => app.close())

  const page = await app.inject({ url: `${BENCHMARK_PREVIEW_PREFIX}good-token/` })
  assert.equal(page.statusCode, 200)
  assert.equal(page.body, '<h1>OK</h1><script src="assets/app.js"></script>')
  assert.match(page.headers['content-type'] as string, /^text\/html/)
  assert.match(page.headers['content-security-policy'] as string, /^sandbox allow-scripts/)
  assert.doesNotMatch(page.headers['content-security-policy'] as string, /allow-same-origin/)
  assert.equal(page.headers['x-content-type-options'], 'nosniff')

  const script = await app.inject({ url: `${BENCHMARK_PREVIEW_PREFIX}good-token/assets/app.js` })
  assert.match(script.headers['content-type'] as string, /^text\/javascript/)

  const slice = await app.inject({ url: `${BENCHMARK_PREVIEW_PREFIX}good-token/assets/clip.mp4`, headers: { range: 'bytes=0-9' } })
  assert.equal(slice.statusCode, 206)
  assert.equal(slice.headers['content-range'], 'bytes 0-9/1000')

  const download = await app.inject({ url: `${BENCHMARK_PREVIEW_PREFIX}good-token/notes.md?download=1` })
  assert.match(download.headers['content-disposition'] as string, /^attachment/)

  assert.equal((await app.inject({ url: `${BENCHMARK_PREVIEW_PREFIX}bad-token/index.html` })).statusCode, 404)
  assert.notEqual((await app.inject({ url: `${BENCHMARK_PREVIEW_PREFIX}good-token/leak.txt` })).statusCode, 200)
  assert.notEqual((await app.inject({ url: `${BENCHMARK_PREVIEW_PREFIX}good-token/..%2F..%2Fetc%2Fpasswd` })).statusCode, 200)
  assert.equal((await app.inject({ url: `${BENCHMARK_PREVIEW_PREFIX}good-token/missing.png` })).statusCode, 404)
})

test('benchmark check: the script runs in the run folder with its variables', async (t) => {
  const root = runFolder(t)
  const passed = await runScript('test -f index.html && test "$SILLAGE_VARIANT" = "fast" && cat "$SILLAGE_RESPONSE_FILE"', {
    cwd: root,
    description: 'test',
    timeoutMs: 10_000,
    env: { SILLAGE_VARIANT: 'fast', SILLAGE_RESPONSE_FILE: join(root, 'notes.md') },
  })
  assert.equal(passed.exitCode, 0)
  assert.equal(passed.stdout, '# notes')
  const failed = await runScript('exit 3', { cwd: root, description: 'test', timeoutMs: 10_000, env: {} })
  assert.equal(failed.exitCode, 3)
  const slow = await runScript('sleep 5', { cwd: root, description: 'test', timeoutMs: 300, env: {} })
  assert.equal(slow.timedOut, true)
  assert.equal(slow.exitCode, null)
})

test('benchmark metrics: time waiting for a human is measured apart, open requests until the end', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'message.started', messageId: 'u1', role: 'user' }],
    [1000, { type: 'permission.requested', requestId: 'p1', toolCallId: 't1', toolName: 'Write', input: {}, suggestions: [] } as unknown as SillageEvent],
    [6000, { type: 'permission.resolved', requestId: 'p1', decision: 'allow' } as unknown as SillageEvent],
    [7000, { type: 'question.requested', requestId: 'q1', questions: [] } as unknown as SillageEvent],
    [9500, { type: 'error', code: 'benchmark_timeout', message: 'cut', recoverable: true }],
  ]))
  assert.equal(metrics.waitingMs, 5000 + 2500)
  assert.equal(metrics.durationMs, null)
})

test('benchmark rerun: same configuration and files, in the original series; ratings stay per run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-bench-db-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values([{ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 }]).run()

  const ctx = { db, config: { paths: { data: dir } } } as unknown as AppContext
  const sessions = { assertCliEnabled: () => undefined }
  const runner = new BenchmarkRunner(ctx, sessions as never, {} as never, {} as never, {} as never)
  // No sweep: this test reads rows, it launches nothing.
  runner.kick = () => undefined

  const variants = [{ id: 'v1', label: 'fast', config: { agent: 'claude', model: 'default', effort: 'low', permissionMode: 'bypassPermissions' } }]
  db.insert(benchmarkTable).values({
    id: 'original', userId: 'owner', name: 'Parser', prompt: 'Write it', variants: JSON.stringify(variants),
    repetitions: 2, concurrency: 'sequential', maxDurationMinutes: 5,
    inputs: JSON.stringify([{ storedAs: '1-brief.txt', filename: 'brief.txt', mimeType: 'text/plain', sizeBytes: 5 }]),
    checkScript: 'true', checkTimeoutSeconds: 30, seriesId: null, createdAt: 1, updatedAt: 1,
  }).run()
  mkdirSync(benchmarkInputDir(dir, 'original'), { recursive: true })
  writeFileSync(join(benchmarkInputDir(dir, 'original'), '1-brief.txt'), 'hello')

  const first = await runner.rerun('original', 'owner')
  assert.equal(first.seriesId, 'original')
  assert.equal(first.prompt, 'Write it')
  assert.equal(first.checkScript, 'true')
  assert.equal(first.variants, JSON.stringify(variants))
  assert.equal(readFileSync(join(benchmarkInputDir(dir, first.id), '1-brief.txt'), 'utf8'), 'hello')
  // A rerun of a rerun still points at the original: one series, not a chain.
  const second = await runner.rerun(first.id, 'owner')
  assert.equal(second.seriesId, 'original')
  const runs = db.select().from(benchmarkRuns).all().filter((run) => run.benchmarkId === second.id)
  assert.deepEqual(runs.map((run) => [run.variantId, run.repetition, run.status]).sort(), [['v1', 1, 'pending'], ['v1', 2, 'pending']])
  await assert.rejects(runner.rerun('original', 'stranger'), /not found/i)

  runner.rate(second.id, runs[0]!.id, 4, 'clean output')
  const [listed] = runner.list('owner').filter((entry) => entry.id === second.id)
  const rated = listed!.runs.find((run) => run.id === runs[0]!.id)!
  assert.equal(rated.rating, 4)
  assert.equal(rated.ratingNote, 'clean output')
  runner.rate(second.id, runs[0]!.id, null, 'ignored')
  assert.equal(runner.list('owner').find((entry) => entry.id === second.id)!.runs.find((run) => run.id === runs[0]!.id)!.ratingNote, null)
  // A run of another benchmark cannot be rated through this one.
  assert.throws(() => runner.rate(first.id, runs[0]!.id, 3, null), /not found/i)

  await runner.delete(second.id)
  assert.equal(existsSync(join(dir, 'benchmarks', second.id)), false)
  assert.equal(runner.list('owner').some((entry) => entry.id === 'original'), true)
})

test('benchmark concurrency: numeric validation and compatibility with legacy clients', async () => {
  const { createBenchmarkBodySchema, updateBenchmarkSettingsBodySchema } = await import('@sillage/protocol')
  const body = { name: 'test', prompt: 'test', variants: [{ config: { agent: 'claude', model: 'default', effort: 'low', permissionMode: 'bypassPermissions' } }] }
  for (const [input, expected] of [[undefined, 1], ['sequential', 1], ['parallel', 4], [7, 7], [60, 60]] as const) {
    assert.equal(createBenchmarkBodySchema.parse({ ...body, concurrency: input }).concurrency, expected)
  }
  // The ceiling follows the largest lineup a continued benchmark can reach (24 × 5 runs).
  for (const concurrency of [0, -1, 1.5, 121, '', null]) {
    assert.equal(updateBenchmarkSettingsBodySchema.safeParse({ repetitions: 1, maxDurationMinutes: 20, concurrency }).success, false)
  }
})

test('benchmark concurrency: per-benchmark slots, live changes, legacy rows and reruns', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-concurrency-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 }).run()
  const ctx = { db, config: { paths: { data: dir } } } as unknown as AppContext
  const runner = new BenchmarkRunner(ctx, { assertCliEnabled: () => undefined } as never, {} as never, {} as never, {} as never)
  runner.kick = () => undefined
  const variants = JSON.stringify([{ id: 'v', label: 'test', config: { agent: 'claude', model: 'default', effort: 'low', permissionMode: 'bypassPermissions' } }])
  for (const [id, concurrency, maxConcurrentRuns] of [['one', 'sequential', null], ['four', 'parallel', null], ['seven', 'parallel', 7]] as const) {
    db.insert(benchmarkTable).values({ id, userId: 'owner', name: id, prompt: 'test', variants, concurrency, maxConcurrentRuns, maxDurationMinutes: 20, createdAt: 1, updatedAt: 1 }).run()
    for (let i = 0; i < 9; i++) db.insert(benchmarkRuns).values({ id: id + i, benchmarkId: id, variantId: 'v', repetition: i + 1, status: 'pending' }).run()
  }
  // Stub CLI startup only: exercise the real database-backed scheduler, including slow starts.
  const scheduler = runner as unknown as {
    launchPending(): Promise<void>
    launch(run: { id: string }): Promise<void>
    launching: Set<string>
  }
  scheduler.launch = async (run) => { scheduler.launching.add(run.id) }
  await scheduler.launchPending()
  const count = (id: string) => [...scheduler.launching].filter((key) => key.startsWith(id)).length
  assert.deepEqual(['one', 'four', 'seven'].map(count), [1, 4, 7])
  await scheduler.launchPending()
  assert.deepEqual(['one', 'four', 'seven'].map(count), [1, 4, 7], 'slow startups do not oversubscribe slots')
  // The test rows hold nine runs of one variant: keep them all while changing the slots.
  const settings = (concurrency: number) => ({ repetitions: 9, concurrency, maxDurationMinutes: 20 })
  runner.updateSettings('one', settings(3))
  runner.updateSettings('seven', settings(2))
  await scheduler.launchPending()
  assert.deepEqual(['one', 'four', 'seven'].map(count), [3, 4, 7], 'lowering leaves existing runs alone')
  assert.equal(runner.list('owner').find((row) => row.id === 'four')!.concurrency, 4)
  assert.equal(runner.list('owner').find((row) => row.id === 'seven')!.concurrency, 2)
  const copy = await runner.rerun('seven', 'owner')
  assert.equal(copy.maxConcurrentRuns, 2)

  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => {
    Object.assign(request, { user: { id: request.headers['x-owner'] ?? 'owner' } })
  })
  registerBenchmarkRoutes(app, ctx, runner)
  t.after(() => app.close())
  const update = (concurrency: unknown, owner = 'owner') => app.inject({
    method: 'PUT', url: '/api/benchmarks/one/settings', headers: { 'x-owner': owner }, payload: { repetitions: 5, maxDurationMinutes: 20, concurrency },
  })
  assert.equal((await update(5)).statusCode, 200)
  assert.equal((await update(0)).statusCode, 400)
  assert.equal((await update(8, 'stranger')).statusCode, 404)
  assert.equal(runner.load('one', 'owner').maxConcurrentRuns, 5)
})

test('benchmark settings: repetitions grow and shrink without deleting results, duration applies live', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-settings-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 }).run()
  const ctx = { db, config: { paths: { data: dir } } } as unknown as AppContext
  const runner = new BenchmarkRunner(ctx, { assertCliEnabled: () => undefined } as never, {} as never, {} as never, {} as never)
  runner.kick = () => undefined
  const config = { agent: 'claude', model: 'default', effort: 'low', permissionMode: 'bypassPermissions' }
  const variants = JSON.stringify(['a', 'b'].map((id) => ({ id, label: id, config })))
  db.insert(benchmarkTable).values({ id: 'bench', userId: 'owner', name: 'bench', prompt: 'test', variants, repetitions: 2, concurrency: 'sequential', maxConcurrentRuns: 1, maxDurationMinutes: 20, createdAt: 1, updatedAt: 1 }).run()
  // Variant a finished both repetitions; variant b finished one and was cancelled before the second.
  for (const [id, variantId, repetition, status] of [['a1', 'a', 1, 'succeeded'], ['a2', 'a', 2, 'succeeded'], ['b1', 'b', 1, 'succeeded'], ['b2', 'b', 2, 'cancelled']] as const) {
    db.insert(benchmarkRuns).values({ id, benchmarkId: 'bench', variantId, repetition, status }).run()
  }
  const runs = () => runner.list('owner')[0]!.runs.map((run) => `${run.variantId}${run.repetition}:${run.status}`).sort()

  runner.updateSettings('bench', { repetitions: 4, concurrency: 3, maxDurationMinutes: 45 })
  assert.deepEqual(runs(), ['a1:succeeded', 'a2:succeeded', 'a3:pending', 'a4:pending', 'b1:succeeded', 'b2:cancelled', 'b3:pending', 'b4:pending'])
  const row = runner.load('bench', 'owner')
  assert.deepEqual([row.repetitions, row.maxConcurrentRuns, row.maxDurationMinutes], [4, 3, 45])

  // Back down: only runs that never started go, and the floor is the highest one that did.
  runner.updateSettings('bench', { repetitions: 2, concurrency: 3, maxDurationMinutes: 45 })
  assert.deepEqual(runs(), ['a1:succeeded', 'a2:succeeded', 'b1:succeeded', 'b2:cancelled'])
  assert.throws(() => runner.updateSettings('bench', { repetitions: 1, concurrency: 3, maxDurationMinutes: 45 }), { code: 'benchmark_repetitions_started' })
  assert.deepEqual(runs(), ['a1:succeeded', 'a2:succeeded', 'b1:succeeded', 'b2:cancelled'], 'a refused change touches nothing')

  // A run whose session is starting is pending in the database, yet no longer droppable.
  runner.updateSettings('bench', { repetitions: 3, concurrency: 3, maxDurationMinutes: 45 })
  const launching = (runner as unknown as { launching: Set<string> }).launching
  launching.add(runner.list('owner')[0]!.runs.find((run) => run.variantId === 'a' && run.repetition === 3)!.id)
  assert.throws(() => runner.updateSettings('bench', { repetitions: 2, concurrency: 3, maxDurationMinutes: 45 }), { code: 'benchmark_repetitions_started' })

  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => { Object.assign(request, { user: { id: 'owner' } }) })
  registerBenchmarkRoutes(app, ctx, runner)
  t.after(() => app.close())
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/benchmarks/bench/settings', payload: payload as object })
  assert.equal((await put({ repetitions: 2, concurrency: 1, maxDurationMinutes: 30 })).statusCode, 409)
  assert.equal((await put({ repetitions: 6, concurrency: 1, maxDurationMinutes: 30 })).statusCode, 400)
  assert.equal((await put({ repetitions: 3, concurrency: 1, maxDurationMinutes: 0 })).statusCode, 400)
  const saved = await put({ repetitions: 3, concurrency: 1, maxDurationMinutes: 30 })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().maxDurationMinutes, 30)
})

const completed = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0, costUsd = 0): SillageEvent & { type: 'turn.completed' } => ({
  type: 'turn.completed', stopReason: 'completed', inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd,
})

test('benchmark metrics: actual Claude 2.1.318 and Codex 0.163.0 counters include cache, not context snapshots', () => {
  // Numeric usage from the reported benchmark; no prompt, response or account data.
  for (const [input, output, read, written, expected] of [
    [4, 9944, 38462, 22512, 60978],
    [6, 11313, 73058, 24564, 97628],
    [4, 9362, 36627, 22749, 59380],
    [20003, 4523, 161024, 0, 181027],
    [21818, 2720, 41472, 0, 63290],
  ]) {
    const metrics = computeRunMetrics(journal([
      [0, { type: 'turn.started' }],
      [5, { type: 'usage.updated', inputTokens: 35000, outputTokens: 200, costUsd: 0 }],
      [10, completed(input!, output!, read!, written!)],
    ]))
    assert.equal(metrics.inputTokens, expected)
    assert.equal(metrics.outputTokens, output)
    assert.equal(metrics.cacheReadTokens, read)
    assert.equal(metrics.cacheCreationTokens, written)
    assert.equal(metrics.costUsd, null, 'unreported cost must not rank as free')
  }
  const interrupted = computeRunMetrics(journal([
    [0, { type: 'turn.started' }],
    [5, { type: 'usage.updated', inputTokens: 1000, outputTokens: 200, costUsd: 0, context: { usedTokens: 1000, maxTokens: 10000, ratio: 0.1 } }],
    [10, completed(0, 0)],
  ]))
  assert.equal(interrupted.inputTokens, null, 'a context snapshot cannot establish turn consumption')
  assert.equal(interrupted.outputTokens, null)
  assert.equal(interrupted.contextTokens, 1000)
})

test('benchmark metrics: Claude native per-result usage includes auxiliary models and avoids cumulative cost double counting', () => {
  const entries = journal([[0, { type: 'turn.started' }], [10, completed(4, 9944, 38462, 22512, 0.3868893)]])
  const first = {
    type: 'result', total_cost_usd: 0.3868893,
    model_usage_since_last_result: {
      main: { inputTokens: 4, outputTokens: 9944, cacheReadInputTokens: 38462, cacheCreationInputTokens: 22512, costUSD: 0.3866844 },
      auxiliary: { inputTokens: 1259, outputTokens: 158, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0002049 },
    },
  }
  const metrics = computeRunMetrics(entries.map((entry) => ({ ...entry, raw: entry.event.type === 'turn.completed' ? first : undefined })), 'claude')
  assert.equal(metrics.inputTokens, 62237)
  assert.equal(metrics.outputTokens, 10102)
  assert.ok(Math.abs(metrics.costUsd! - 0.3868893) < 1e-9)

  const turns = journal([[0, completed(10, 20, 30, 40, 2)], [10, completed(1, 2, 3, 4, 5)]])
  const cumulative = turns.map((entry, i) => ({ ...entry, raw: { type: 'result', total_cost_usd: i ? 5 : 2 } }))
  assert.equal(computeRunMetrics(cumulative, 'claude').costUsd, 5)
  assert.equal(computeRunMetrics([{ ...turns[0]!, raw: { type: 'result', total_cost_usd: 0 } }], 'claude').costUsd, 0,
    'an explicitly reported zero differs from a missing cost')
  const perResult = cumulative.map((entry, i) => ({ ...entry, raw: { ...entry.raw, model_usage_since_last_result: {
    main: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: i ? 3 : 2 },
  } } }))
  assert.equal(computeRunMetrics(perResult, 'claude').costUsd, 5)
  assert.equal(computeRunMetrics(perResult, 'claude').inputTokens, 16)
})

test('benchmark metrics: overlapping human waits form a union; async questions do not stop the clock', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'turn.started' }],
    [10, { type: 'question.requested', requestId: 'async', questions: [], blocking: false }],
    [20, { type: 'question.requested', requestId: 'a', questions: [] }],
    [30, { type: 'question.requested', requestId: 'b', questions: [] }],
    [40, { type: 'question.requested', requestId: 'a', questions: [] }],
    [50, { type: 'question.resolved', requestId: 'a', status: 'answered', answers: {}, decidedBy: null }],
    [60, { type: 'question.resolved', requestId: 'b', status: 'answered', answers: {}, decidedBy: null }],
    [70, { type: 'question.requested', requestId: 'cut', questions: [] }],
    [90, { type: 'session.ended', reason: 'interrupted' }],
  ]))
  assert.equal(metrics.waitingMs, 60)
})

test('benchmark metrics: the clock stops for humans and idle gaps, not for background work', () => {
  const metrics = computeRunMetrics(journal([
    [0, { type: 'turn.started' }],
    [1000, { type: 'permission.requested', requestId: 'p1', toolName: 'Bash', input: {}, title: null, description: null, displayName: null, suggestions: [] }],
    [61_000, { type: 'permission.resolved', requestId: 'p1', decision: 'allowed', scope: 'once', decidedBy: null }],
    [62_000, { type: 'message.completed', messageId: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }], parentToolCallId: null }],
    [63_000, { type: 'background.updated', tasks: [{ id: 'b1', kind: 'bash', description: 'npm run build' }] }],
    [64_000, completed(1, 1)],
    // The agent waits on its own build between turns: that is still its time.
    [74_000, { type: 'background.updated', tasks: [] }],
    [75_000, { type: 'turn.started' }],
    [80_000, completed(1, 1)],
    // Two minutes later someone writes again: the pause belongs to nobody.
    [200_000, { type: 'message.started', messageId: 'u2', role: 'user' }],
    [201_000, completed(1, 1)],
  ]))
  assert.equal(metrics.waitingMs, 60_000)
  assert.equal(metrics.firstTextMs, 2000)
  assert.equal(metrics.durationMs, 1000 + 3000 + 10_000 + 5000 + 1000)
  assert.equal(metrics.elapsedMs, 201_000)
})

test('benchmark metrics: snapshots without a journal lose their human wait, and their tokens are fixed only once', () => {
  const v2 = { ...computeRunMetrics([]), version: 2, durationMs: 4_042_000, waitingMs: 1_921_000, inputTokens: 100, cacheReadTokens: 60, costUsd: 0 }
  const upgraded = upgradeSnapshot(v2)
  assert.equal(upgraded.version, RUN_METRICS_VERSION)
  assert.equal(upgraded.durationMs, 2_121_000)
  assert.equal(upgraded.elapsedMs, 4_042_000)
  assert.equal(upgraded.inputTokens, 100, 'a version 2 total already includes cache')
  assert.equal(upgraded.costUsd, 0)
  assert.equal(upgradeSnapshot({ ...v2, version: undefined }).inputTokens, 160)
})

test('benchmark metrics: repeated tool notifications do not inflate counts or time', () => {
  const start: SillageEvent = { type: 'tool.started', toolCallId: 'tool', name: 'Bash', input: {}, parentToolCallId: null }
  const end: SillageEvent = { type: 'tool.completed', toolCallId: 'tool', output: '', isError: true, durationMs: 25 }
  const metrics = computeRunMetrics(journal([[0, start], [1, start], [25, end], [26, end]]))
  assert.equal(metrics.toolCalls, 1)
  assert.equal(metrics.toolErrors, 1)
  assert.equal(metrics.toolDurationMs, 25)
  assert.deepEqual(metrics.toolsByName, { Bash: 1 })
})

test('benchmark API: legacy snapshots are repaired once and exclude post-benchmark conversation turns', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-metrics-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(benchmarkTable).values({ id: 'bench', userId: 'owner', name: 'test', prompt: 'test',
    variants: JSON.stringify([{ id: 'v', label: 'Codex', config: { agent: 'codex', model: 'test', reasoningEffort: 'medium', askForApproval: 'never', sandbox: 'danger-full-access' } }]),
    maxDurationMinutes: 10, createdAt: 1, updatedAt: 1 }).run()
  db.insert(conversations).values({ id: 'c', userId: 'owner', title: 'run', agent: 'codex', status: 'idle', config: '{}', createdAt: 1, updatedAt: 1, lastSeq: 4 }).run()
  const entries = journal([[0, { type: 'turn.started' }], [100, completed(4, 50, 30, 20)], [500, { type: 'turn.started' }], [900, completed(999, 999, 999)]])
  for (const entry of entries) db.insert(events).values({ conversationId: 'c', seq: entry.seq, ts: entry.ts, type: entry.event.type, payload: JSON.stringify(entry.event) }).run()
  const legacy = { ...computeRunMetrics([]), version: undefined, inputTokens: 4, outputTokens: 50, cacheReadTokens: 30, cacheCreationTokens: 20, costUsd: 0 }
  db.insert(benchmarkRuns).values([
    { id: 'run', benchmarkId: 'bench', variantId: 'v', conversationId: 'c', repetition: 1, status: 'succeeded', finishedAt: 1_000_200, metrics: JSON.stringify(legacy) },
    { id: 'deleted', benchmarkId: 'bench', variantId: 'v', repetition: 2, status: 'succeeded', finishedAt: 1_000_200, metrics: JSON.stringify(legacy) },
  ]).run()
  const ctx = { db, config: {} } as AppContext
  const runner = new BenchmarkRunner(ctx, {} as never, {} as never, {} as never, {} as never)
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('preHandler', async (request) => { Object.assign(request, { user: { id: 'owner' } }) })
  registerBenchmarkRoutes(app, ctx, runner)
  t.after(() => app.close())
  const response = await app.inject({ url: '/api/benchmarks/bench' })
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json()
  for (const run of result.runs) {
    assert.equal(run.metrics.inputTokens, 54)
    assert.equal(run.metrics.costUsd, null)
    assert.equal(run.metrics.version, RUN_METRICS_VERSION)
  }
  assert.equal(result.runs.find((run: { id: string }) => run.id === 'run').metrics.durationMs, 100)
  const stored = db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, 'run')).get()!.metrics
  db.delete(events).where(eq(events.conversationId, 'c')).run()
  assert.deepEqual((await app.inject({ url: '/api/benchmarks' })).json()[0].runs, result.runs)
  assert.equal(db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, 'run')).get()!.metrics, stored)
})

test('default labels name the model a run announced, written labels stay', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-bench-labels-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 }).run()
  const claude = (model: string) => ({ agent: 'claude', model, effort: 'medium', permissionMode: 'bypassPermissions' })
  const variants = JSON.stringify([
    { id: 'alias', label: 'sonnet · medium', config: claude('sonnet') },
    { id: 'unset', label: 'default · medium', config: claude('default') },
    { id: 'named', label: 'My pick', config: claude('haiku') },
    { id: 'live', label: 'opus · medium', config: claude('opus') },
    { id: 'waiting', label: 'haiku · medium', config: claude('haiku') },
  ])
  db.insert(benchmarkTable).values({ id: 'b', userId: 'owner', name: 'b', prompt: 'test', variants, concurrency: 'sequential', maxDurationMinutes: 20, createdAt: 1, updatedAt: 1 }).run()
  const announced = { alias: 'claude-sonnet-5-5', unset: 'claude-opus-5-5', named: 'claude-haiku-5-5', waiting: null }
  for (const [variantId, model] of Object.entries(announced)) {
    db.insert(benchmarkRuns).values({ id: variantId, benchmarkId: 'b', variantId, repetition: 1, status: 'running', metrics: model ? JSON.stringify({ model }) : null }).run()
  }
  db.insert(conversations).values({ id: 'live-session', userId: 'owner', title: 'run', agent: 'claude', status: 'running', config: '{}', createdAt: 1, updatedAt: 1 }).run()
  db.insert(benchmarkRuns).values({ id: 'live', benchmarkId: 'b', variantId: 'live', conversationId: 'live-session', repetition: 1, status: 'running' }).run()
  db.insert(events).values({ conversationId: 'live-session', seq: 1, ts: 2, type: 'session.started', payload: JSON.stringify({ type: 'session.started', model: 'claude-opus-5-5' }) }).run()
  const ctx = { db, config: { paths: { data: dir } } } as unknown as AppContext
  const runner = new BenchmarkRunner(ctx, { assertCliEnabled: () => undefined } as never, {} as never, {} as never, {} as never)
  const listed = runner.list('owner')[0]!.variants
  const labels = Object.fromEntries(listed.map((variant) => [variant.id, variant.label]))
  // Without a price list there is no public name: pages show the technical label.
  assert.deepEqual(labels, { alias: 'claude-sonnet-5-5 · medium', unset: 'claude-opus-5-5 · medium', named: 'My pick', live: 'claude-opus-5-5 · medium', waiting: 'haiku · medium' })
  const technical = Object.fromEntries(listed.map((variant) => [variant.id, variant.technicalLabel]))
  assert.deepEqual(technical, { alias: 'claude-sonnet-5-5 · medium', unset: 'claude-opus-5-5 · medium', named: 'claude-haiku-5-5 · medium', live: 'claude-opus-5-5 · medium', waiting: 'haiku · medium' })
  assert.deepEqual(listed.map((variant) => variant.labelIsCustom), [false, false, true, false, false])
})

test('benchmark timeout: time spent waiting for an answer does not count against the maximum duration', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-bench-timeout-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  const minute = 60_000
  const start = 1_000_000
  db.insert(benchmarkTable).values({ id: 'bench', userId: 'owner', name: 'test', prompt: 'test',
    variants: JSON.stringify([{ id: 'v', label: 'Opus', config: { agent: 'claude', model: 'opus', effort: 'medium', permissionMode: 'bypassPermissions' } }]),
    maxDurationMinutes: 10, createdAt: 1, updatedAt: 1 }).run()
  db.insert(conversations).values({ id: 'c', userId: 'owner', title: 'run', agent: 'claude', status: 'awaiting_input', config: '{}', createdAt: 1, updatedAt: 1 }).run()
  db.insert(benchmarkRuns).values({ id: 'run', benchmarkId: 'bench', variantId: 'v', conversationId: 'c', repetition: 1, status: 'running', startedAt: start }).run()
  const log = new EventLog(db)
  const write = (seq: number, ts: number, event: SillageEvent) =>
    db.insert(events).values({ conversationId: 'c', seq, ts, type: event.type, payload: JSON.stringify(event) }).run()
  write(1, start, { type: 'turn.started' })
  write(2, start + minute, { type: 'permission.requested', requestId: 'p', toolName: 'Bash', input: {}, title: null, description: null, displayName: null, suggestions: [] })
  db.update(conversations).set({ lastSeq: 2 }).where(eq(conversations.id, 'c')).run()
  assert.equal(readWaitingMs(log, 'c', start + 15 * minute), 14 * minute, 'an open request waits until now')

  const terminated: string[] = []
  const ctx = { db, config: { paths: { data: dir } } } as unknown as AppContext
  const runner = new BenchmarkRunner(ctx, { terminate: async (id: string) => { terminated.push(id) } } as never, {} as never, log, {} as never)
  const status = () => db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, 'run')).get()!.status

  // Fifteen minutes on the wall, one of work: the run keeps waiting for its answer.
  await runner.tick(start + 15 * minute)
  assert.equal(status(), 'running')
  assert.deepEqual(terminated, [])

  // Answered after thirteen minutes; ten minutes of work later, the limit applies.
  write(3, start + 14 * minute, { type: 'permission.resolved', requestId: 'p', decision: 'allowed', scope: 'once', decidedBy: null })
  db.update(conversations).set({ status: 'running', lastSeq: 3 }).where(eq(conversations.id, 'c')).run()
  await runner.tick(start + 22 * minute)
  assert.equal(status(), 'running')
  await runner.tick(start + 24 * minute)
  assert.equal(status(), 'timed_out')
  assert.deepEqual(terminated, ['c'])
})
