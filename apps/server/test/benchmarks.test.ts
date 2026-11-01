import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JournalEntry, SillageEvent } from '@sillage/protocol'
import { computeRunMetrics } from '../src/benchmarks/metrics.js'
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
import { benchmarkRuns, benchmarks as benchmarkTable, openDatabase, runMigrations, users } from '@sillage/db'
import { BenchmarkRunner, benchmarkInputDir } from '../src/benchmarks/runner.js'
import type { AppContext } from '../src/http/context.js'

/** Journal entries at the given millisecond offsets, in order. */
function journal(steps: [number, SillageEvent][]): JournalEntry[] {
  return steps.map(([ts, event], index) => ({ conversationId: 'c', seq: index + 1, ts: 1_000_000 + ts, event }))
}

test('benchmark metrics: durations run from the user message, tokens add up across turns', () => {
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

  assert.equal(metrics.durationMs, 8000)
  assert.equal(metrics.firstTextMs, 800)
  assert.equal(metrics.inputTokens, 11)
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
