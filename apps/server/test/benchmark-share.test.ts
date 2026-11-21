import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { unzipSync } from 'fflate'
import { benchmarkRuns, benchmarkShares, benchmarks, conversations, openDatabase, personalWorkspaces, runMigrations, users } from '@sillage/db'
import { BENCHMARK_SHARE_PREFIX, benchmarkLiveUrl, benchmarkShareOptionsSchema, publishBenchmarkShareBodySchema, type BenchmarkDto } from '@sillage/protocol'
import { eq } from 'drizzle-orm'
import { assessRunFolder, pageNeedsBuild } from '../src/benchmarks/exportability.js'
import { BenchmarkRunner } from '../src/benchmarks/runner.js'
import { LEGACY_PAGE_SCRIPT_HASHES, PAGE_SCRIPT_HASHES, renderBenchmarkShare, type SharePage } from '../src/benchmarks/share-page.js'
import { SHARE_PAGE_CSP } from '../src/benchmarks/share-policy.js'
import { displayOrder, BenchmarkShares } from '../src/benchmarks/share.js'
import type { AppContext } from '../src/http/context.js'
import { registerErrorHandler } from '../src/http/errors.js'
import { registerBenchmarkRoutes } from '../src/http/routes/benchmarks.js'

function folder(t: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sillage-share-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

test('benchmark exportability: plain pages go out, projects that need a build or a server do not', async (t) => {
  const page = await assessRunFolder(folder(t, { 'index.html': '<script src="app.js"></script>', 'app.js': 'fetch("data.json")', 'data.json': '{}', 'other.html': 'x' }))
  assert.deepEqual([page.mode, page.reason, page.entry, page.files.length], ['page', null, 'index.html', 4])

  // A lone page with another name is still the page to open.
  assert.equal((await assessRunFolder(folder(t, { 'piano.html': '<h1>ok</h1>', 'assets/a.css': '' }))).entry, 'piano.html')

  const vite = await assessRunFolder(folder(t, {
    'index.html': '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    'package.json': '{"devDependencies":{"vite":"^7"}}', 'src/main.tsx': 'export {}',
  }))
  assert.deepEqual([vite.mode, vite.reason], ['none', 'build'])

  // The built copy next to the sources is what a reader can open.
  const built = await assessRunFolder(folder(t, {
    'index.html': '<script type="module" src="/src/main.tsx"></script>', 'package.json': '{"devDependencies":{"vite":"^7"}}',
    'dist/index.html': '<script type="module" src="./assets/index.js"></script>', 'dist/assets/index.js': 'console.log(1)',
  }))
  assert.deepEqual([built.mode, built.entry], ['page', 'dist/index.html'])

  const backend = await assessRunFolder(folder(t, {
    'index.html': '<script src="app.js"></script>', 'app.js': 'fetch("/api/todos").then(r => r.json())',
    'server.py': 'from flask import Flask', 'requirements.txt': 'flask',
  }))
  assert.deepEqual([backend.mode, backend.reason], ['none', 'server'])

  // A server beside a page that never calls it does not condemn the page.
  const independent = await assessRunFolder(folder(t, { 'index.html': '<h1>static</h1>', 'serve.py': 'import http.server' }))
  assert.equal(independent.mode, 'page')

  const api = await assessRunFolder(folder(t, { 'main.go': 'package main', 'go.mod': 'module x', 'README.md': '# api' }))
  assert.deepEqual([api.mode, api.reason], ['none', 'server'])

  const media = await assessRunFolder(folder(t, { 'cover.png': 'png', 'story.md': '# Once', 'blob.bin': '0' }))
  assert.deepEqual([media.mode, media.files.map((file) => file.path)], ['files', ['cover.png', 'story.md']])

  assert.equal((await assessRunFolder(folder(t, {}))).reason, 'empty')
  assert.equal((await assessRunFolder(null)).reason, 'missing')
  // Tooling folders never count, as in the deliverables list.
  assert.equal((await assessRunFolder(folder(t, { 'node_modules/x/index.html': 'x', '.cache/a.html': 'x' }))).reason, 'empty')

  assert.equal(pageNeedsBuild('<script type="module">import React from "react"</script>'), true)
  assert.equal(pageNeedsBuild('<script type="importmap">{}</script><script type="module">import * as THREE from "three"</script>'), false)
  assert.equal(pageNeedsBuild('<script type="module">import { a } from "./a.js"; import x from "https://esm.sh/x"</script>'), false)
})

const variants = [
  { id: 'v1', label: 'Opus <b>max</b>', config: { agent: 'claude', model: 'opus', effort: 'max', permissionMode: 'bypassPermissions' } },
  { id: 'v2', label: 'Terra high', config: { agent: 'codex', model: 'terra', reasoningEffort: 'high', askForApproval: 'never', sandbox: 'danger-full-access' } },
]
const metrics = (durationMs: number, costUsd: number | null) => ({
  version: 2, durationMs, waitingMs: 0, firstTextMs: 10, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUsd, toolCalls: 3, toolsByName: {}, toolErrors: 0, toolDurationMs: 0, assistantMessages: 1, outputChars: 10, contextTokens: null, model: 'm',
})

/** A DTO variant as the runner returns it: a display label, the exact technical one, a price. */
const dtoVariants = variants.map((variant) => ({ ...variant, technicalLabel: `${variant.config.model} · technical`, labelIsCustom: true, model: null, listPrice: null }))

function pageRun(id: string, variantId: string, durationMs: number, extra: Record<string, unknown> = {}) {
  return {
    id, variantId, repetition: 1, conversationId: null, status: 'succeeded' as const, startedAt: 1, finishedAt: 2, error: null, cliVersion: '1',
    metrics: metrics(durationMs, 0.5), response: '**Done** <img src=x onerror=alert(1)> [local](file:///etc) [web](https://example.com)',
    check: null, files: [], previewToken: null, rating: 4, ratingNote: null, followUps: [], ...extra,
  }
}

function sharePage(benchmark: BenchmarkDto, change: Omit<Partial<SharePage>, 'options'> & { options?: Record<string, unknown> } = {}): SharePage {
  const { options, ...rest } = change
  return {
    benchmark, order: benchmark.variants.map((variant) => variant.id), sharedAt: Date.UTC(2026, 10, 16), live: false,
    links: { page: 'index.html', slides: 'slides.html', exit: 'index.html' }, comparisons: [],
    options: benchmarkShareOptionsSchema.parse({ title: 'Piano <battle>', locale: 'fr', ...options }),
    runs: benchmark.runs.map((run, index) => index === 0
      ? { run, mode: 'page' as const, reason: null, dir: 'runs/1', entry: 'my page/index.html', files: [], excerpts: {} }
      : { run, mode: 'none' as const, reason: 'build' as const, dir: null, entry: null, files: [], excerpts: {} }),
    ...rest,
  }
}

/** What a reader sees before revealing: no attribute, no script, no data block. */
function visibleText(html: string): string {
  return html.replace(/data-real="[^"]*"/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
}

test('benchmark share page: pinned script, escaped content, blind names out of sight', () => {
  const benchmark = {
    id: 'b', name: 'Piano', prompt: 'Build a <piano>', variants: dtoVariants, comparisons: [], repetitions: 1, concurrency: 1, maxDurationMinutes: 5, inputs: [],
    checkScript: null, checkTimeoutSeconds: 1, seriesId: null, createdAt: 1, updatedAt: 1, runs: [pageRun('r1', 'v1', 60_000), pageRun('r2', 'v2', 95_000)],
  } as unknown as BenchmarkDto
  const page = (blind: boolean) => renderBenchmarkShare(sharePage(benchmark, { options: { blind } }))
  const html = page(false)
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!
  assert.ok(SHARE_PAGE_CSP.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`))
  // One executable script: the data block is JSON the policy never runs.
  assert.equal(html.match(/<script>/g)!.length, 1)
  assert.match(html, /<h1>Piano &lt;battle&gt;<\/h1>/)
  assert.match(html, /Build a &lt;piano&gt;/)
  assert.match(html, /Opus &lt;b&gt;max&lt;\/b&gt;/)
  assert.doesNotMatch(html, /<img src=x/)
  assert.doesNotMatch(html, /href="file:/)
  assert.match(html, /href="https:\/\/example\.com" target="_blank"/)
  assert.match(html, /<iframe src="runs\/1\/my%20page\/index\.html" sandbox="allow-scripts[^"]*"/)
  assert.doesNotMatch(html, /allow-same-origin/)
  assert.match(html, /étape de build/)
  // Names come with their CLI's mark and the exact model on a second line.
  assert.match(html, /<span class="mark"><svg/)
  assert.match(html, /Claude Code · opus · technical/)
  // The faster variant leads its column; ratings stay private unless asked for.
  assert.match(html, /<td class="best">1 min/)
  assert.doesNotMatch(html, /\/ 5</)
  // The slideshow sits beside the page.
  assert.match(html, /<a class="pill" href="slides\.html">/)

  const blind = page(true)
  assert.doesNotMatch(visibleText(blind), /Opus|Terra|Claude Code|Codex|technical|class="mark"/)
  assert.match(blind, /data-real="Terra high" data-blind="Variante B">Variante B</)
})

test('benchmark share page: scripts of published pages keep running after a script change', () => {
  // Frozen literal of the script every page published before this change carries; never derive it.
  assert.ok(LEGACY_PAGE_SCRIPT_HASHES.includes('CP+VGVFiB9dLlby8z5RBGKsjF58PlNb92zIBfJP9XeY='))
  for (const hash of PAGE_SCRIPT_HASHES) assert.ok(SHARE_PAGE_CSP.includes(`'sha256-${hash}'`), hash)
  assert.match(SHARE_PAGE_CSP, /frame-ancestors 'none'/)
  assert.doesNotMatch(SHARE_PAGE_CSP, /unsafe-eval|script-src[^;]*unsafe-inline/)
})

test('benchmark share options: what older clients send still parses, and the worst case fits a link', () => {
  const legacy = benchmarkShareOptionsSchema.parse({ title: 'x', note: '', includePrompt: true, includeResponses: true, includeMetrics: true, includeRatings: false, blind: false, locale: 'fr' })
  assert.deepEqual([legacy.includeChart, legacy.includeSlides, legacy.comparisons, legacy.revealAt], [true, true, null, 'each'])
  assert.equal(publishBenchmarkShareBodySchema.parse({ title: 'x', expiresAt: null }).includeChart, true)
  // Unknown keys from a newer client are dropped, not rejected.
  assert.equal('future' in benchmarkShareOptionsSchema.parse({ title: 'x', future: 1 }), false)
  const worst = benchmarkShareOptionsSchema.parse({
    title: '"'.repeat(120), note: '"'.repeat(2000), includeRatings: true, blind: true, revealAt: 'end', locale: 'fr',
    comparisons: Array.from({ length: 8 }, (_, index) => `c${index}`.padEnd(40, 'x')),
  })
  assert.ok(JSON.stringify(worst).length < 8000)
})

test('benchmark share page: one chart per measure, winners among runs that succeeded only', () => {
  const crashed = pageRun('r3', 'v3', 1_000, { status: 'failed' })
  const benchmark = {
    id: 'b', name: 'Piano', prompt: 'p', comparisons: [],
    variants: [...dtoVariants, { id: 'v3', label: 'Crash', technicalLabel: 'crash', labelIsCustom: true, model: null, listPrice: null, config: variants[0]!.config }],
    repetitions: 2, concurrency: 1, maxDurationMinutes: 5, inputs: [], checkScript: 'true', checkTimeoutSeconds: 1, seriesId: null, createdAt: 1, updatedAt: 1,
    runs: [
      pageRun('r1', 'v1', 60_000, { check: { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }, rating: 3 }),
      pageRun('r1b', 'v1', 80_000, { repetition: 2, check: { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }, rating: 5 }),
      pageRun('r2', 'v2', 95_000, { check: { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }, rating: 5 }),
      pageRun('r2b', 'v2', 50_000, { repetition: 2, check: { passed: false, exitCode: 1, timedOut: false, stdout: '', stderr: '', durationMs: 1 }, rating: 1 }),
      crashed,
    ],
  } as unknown as BenchmarkDto
  const html = renderBenchmarkShare(sharePage(benchmark, { options: { includeRatings: true } }))
  for (const key of ['durationMs', 'tokens', 'costUsd', 'toolCalls', 'passRate', 'rating']) assert.match(html, new RegExp(`data-chart="${key}"`), key)
  // Neither the run that crashed after a second nor v2's quick run that failed its check is the
  // fastest: v1's median of 70 s beats v2's only passing run, 95 s.
  const durationRows = /data-chart="durationMs"[\s\S]*?<\/figure>/.exec(html)![0]
  assert.match(durationRows, /class="crow best" data-index="0"/)
  assert.match(durationRows, /1 min 10 s/)
  assert.doesNotMatch(durationRows, /class="crow best" data-index="2"/)
  // Two eligible runs of v1: the bar is their median and each run is a dot.
  assert.equal((durationRows.match(/class="cdot"/g) ?? []).length, 2)
  // Tool calls have no better direction: nobody leads that chart.
  assert.doesNotMatch(/data-chart="toolCalls"[\s\S]*?<\/figure>/.exec(html)![0], /crow best/)
  // Ratings read as medians of eligible runs: 3 and 5 make 4, v2 keeps its passing 5.
  assert.match(html, /<td>4 \/ 5<span class="bar">/)
  assert.match(html, /<td class="best">5 \/ 5/)
  // Check results: every passed check counts, failures included in the total.
  assert.match(html, /<td class="fail">1 (?:sur|of) 2/)
  const data = JSON.parse(/<script type="application\/json" id="bench-data">([\s\S]*?)<\/script>/.exec(html)![1]!)
  assert.deepEqual(data.measures.find((measure: { key: string }) => measure.key === 'durationMs').values.map((value: { eligible: boolean }) => value.eligible), [true, true, false])
  // With a single eligible variant there is no one to beat: nobody leads.
  const alone = renderBenchmarkShare(sharePage({ ...benchmark, runs: benchmark.runs.filter((run) => run.variantId !== 'v2') } as BenchmarkDto))
  assert.doesNotMatch(/data-chart="durationMs"[\s\S]*?<\/figure>/.exec(alone)![0], /crow best/)

  const withoutChart = renderBenchmarkShare(sharePage(benchmark, { options: { includeChart: false } }))
  assert.doesNotMatch(withoutChart, /data-chart=/)
  assert.match(withoutChart, /<table>/)
})

test('benchmark share page: comparisons, a data block that user text cannot close, no names on blind pages', () => {
  const benchmark = {
    id: 'b', name: 'Piano', prompt: 'p', variants: dtoVariants, repetitions: 1, concurrency: 1, maxDurationMinutes: 5, inputs: [], checkScript: null,
    checkTimeoutSeconds: 1, seriesId: null, createdAt: 1, updatedAt: 1, runs: [pageRun('r1', 'v1', 60_000), pageRun('r2', 'v2', 95_000)],
    comparisons: [{ id: 'c1', title: 'Sonnet </script><script>alert(1)</script> vs Terra', variantIds: ['v2', 'v1'] }],
  } as unknown as BenchmarkDto
  const comparisons = benchmark.comparisons
  const html = renderBenchmarkShare(sharePage(benchmark, { comparisons }))
  const block = /<script type="application\/json" id="bench-data">([\s\S]*?)<\/script>/.exec(html)![1]!
  assert.doesNotMatch(block, /</)
  const data = JSON.parse(block)
  assert.deepEqual(data.featured, [{ title: 'Sonnet </script><script>alert(1)</script> vs Terra', indices: [1, 0] }])
  assert.deepEqual(data.letters, ['A', 'B'])
  assert.match(html, /data-pick="0"[^>]*aria-pressed="false"/)
  assert.match(html, /data-featured="0"/)
  assert.doesNotMatch(html, /<script>alert/)

  // A title the author wrote can name the models: the blind page shows letters until revealed.
  const blind = renderBenchmarkShare(sharePage(benchmark, { comparisons, options: { blind: true } }))
  assert.doesNotMatch(visibleText(blind), /Sonnet|Terra|Opus/)
  assert.match(blind, /data-blind="B vs A">B vs A</)
})

test('benchmark share order: a blind order is stable for one seed and keeps known variants in place', () => {
  // Only ids matter to the order.
  const variant = (id: string) => ({ id }) as BenchmarkDto['variants'][number]
  const lineup = { variants: ['v1', 'v2', 'v3', 'v4', 'v5'].map(variant) }
  assert.deepEqual(displayOrder(lineup, { blind: false }, 'seed'), ['v1', 'v2', 'v3', 'v4', 'v5'])
  const blind = displayOrder(lineup, { blind: true }, 'seed')
  assert.deepEqual(displayOrder(lineup, { blind: true }, 'seed'), blind)
  assert.notDeepEqual(blind, ['v1', 'v2', 'v3', 'v4', 'v5'])
  // A variant added later slots in without reordering the others.
  const grown = displayOrder({ variants: [...lineup.variants, variant('v6')] }, { blind: true }, 'seed')
  assert.deepEqual(grown.filter((id) => id !== 'v6'), blind)
})

test('benchmark sharing: a frozen public snapshot, an identical archive, revocation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-share-db-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values([
    { id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', isAdmin: false, createdAt: 1 },
    { id: 'other', username: 'other', displayName: 'other', passwordHash: '', isAdmin: true, createdAt: 1 },
  ]).run()

  const pageRoot = folder(t, { 'index.html': '<h1>Piano</h1><script src="keys.js"></script>', 'keys.js': 'console.log("la")', '.env': 'SECRET=1' })
  const secret = folder(t, { 'secret.txt': 'nope' })
  symlinkSync(join(secret, 'secret.txt'), join(pageRoot, 'leak.txt'))
  const viteRoot = folder(t, { 'index.html': '<script type="module" src="/src/main.ts"></script>', 'src/main.ts': 'export {}', 'package.json': '{"devDependencies":{"vite":"1"}}' })

  db.insert(benchmarks).values({ id: 'bench', userId: 'owner', name: 'Piano', prompt: 'Build a piano', variants: JSON.stringify(variants), maxDurationMinutes: 10, createdAt: 1, updatedAt: 1 }).run()
  for (const [id, root, variantId] of [['c1', pageRoot, 'v1'], ['c2', viteRoot, 'v2']] as const) {
    db.insert(personalWorkspaces).values({ id: `w-${id}`, userId: 'owner', name: id, path: root, createdAt: 1 }).run()
    db.insert(conversations).values({ id, userId: 'owner', title: id, agent: 'claude', status: 'idle', config: '{}', workspaceId: `w-${id}`, createdAt: 1, updatedAt: 1, lastSeq: 0 }).run()
    db.insert(benchmarkRuns).values({
      id: `run-${id}`, benchmarkId: 'bench', variantId, conversationId: id, repetition: 1, status: 'succeeded', finishedAt: 5,
      metrics: JSON.stringify(metrics(variantId === 'v1' ? 30_000 : 90_000, null)), response: `Answer of ${variantId}`, previewToken: `token-${id}`, rating: 5, ratingNote: `Private take on ${variantId}`,
    }).run()
  }

  const ctx = { db, config: { paths: { data: dir }, server: { publicUrl: 'https://sillage.example' } } } as unknown as AppContext
  const runner = new BenchmarkRunner(ctx, { terminate: async () => undefined } as never, {} as never, {} as never, {} as never)
  runner.kick = () => undefined
  const app = Fastify()
  registerErrorHandler(app)
  let userId = 'owner'
  app.addHook('preHandler', async (request) => { Object.assign(request, { user: { id: userId } }) })
  registerBenchmarkRoutes(app, ctx, runner)
  t.after(() => app.close())

  const state = (await app.inject({ url: '/api/benchmarks/bench/share' })).json()
  assert.equal(state.canPublish, true)
  assert.deepEqual(state.runs.map((run: { mode: string; reason: string | null; entry: string | null }) => [run.mode, run.reason, run.entry]), [['page', null, 'index.html'], ['none', 'build', null]])
  // Hidden files and links stay out of the inventory, so out of the snapshot.
  assert.equal(state.runs[0].files, 2)

  // Benchmarks are personal: an admin who does not own it cannot share it.
  userId = 'other'
  assert.equal((await app.inject({ url: '/api/benchmarks/bench/share' })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: '/api/benchmarks/bench/share', payload: { title: 'x', expiresAt: null } })).statusCode, 404)
  userId = 'owner'

  assert.equal((await app.inject({ method: 'POST', url: '/api/benchmarks/bench/share', payload: { title: 'x', expiresAt: 5 } })).statusCode, 400)
  const published = await app.inject({ method: 'POST', url: '/api/benchmarks/bench/share', payload: { title: 'Piano battle', locale: 'en', expiresAt: null } })
  assert.equal(published.statusCode, 201, published.body)
  const share = published.json()
  assert.match(share.url, /^https:\/\/sillage\.example\/s\/b\/[A-Za-z0-9_-]{32}\/$/)
  const base = `${BENCHMARK_SHARE_PREFIX}${share.id}`

  assert.equal((await app.inject({ url: base })).headers.location, `${base}/`)
  const page = await app.inject({ url: `${base}/` })
  assert.equal(page.statusCode, 200)
  assert.equal(page.headers['content-security-policy'], SHARE_PAGE_CSP)
  assert.match(page.headers['x-robots-tag'] as string, /noindex/)
  assert.match(page.body, /<h1>Piano battle<\/h1>/)
  assert.match(page.body, /<iframe src="runs\/1\/index\.html"/)
  assert.match(page.body, /needs a build step/)
  // The blocked run still speaks through its final message.
  assert.match(page.body, /Answer of v2/)
  assert.doesNotMatch(page.body, /token-c1|\/ 5</)

  const production = await app.inject({ url: `${base}/runs/1/index.html` })
  assert.equal(production.body, '<h1>Piano</h1><script src="keys.js"></script>')
  assert.match(production.headers['content-security-policy'] as string, /^sandbox allow-scripts/)
  assert.doesNotMatch(production.headers['content-security-policy'] as string, /allow-same-origin/)
  assert.equal((await app.inject({ url: `${base}/runs/1/keys.js` })).statusCode, 200)
  for (const path of ['runs/1/.env', 'runs/1/leak.txt', 'runs/2/index.html', '..%2F..%2Ftest.sqlite']) {
    assert.notEqual((await app.inject({ url: `${base}/${path}` })).statusCode, 200, path)
  }

  // The slideshow is published beside the page, under the page's policy rather than the sandbox.
  const slides = await app.inject({ url: `${base}/slides.html` })
  assert.equal(slides.statusCode, 200)
  assert.equal(slides.headers['content-security-policy'], SHARE_PAGE_CSP)
  assert.match(slides.headers['content-type'] as string, /^text\/html/)
  assert.match(page.body, /href="slides\.html"/)
  // The options are kept so the link can be regenerated later.
  const stored = db.select().from(benchmarkShares).where(eq(benchmarkShares.id, share.id)).get()!
  assert.equal(benchmarkShareOptionsSchema.parse(JSON.parse(stored.options!)).title, 'Piano battle')
  assert.equal(share.refreshable, true)
  assert.equal(share.refreshedAt, null)

  // Frozen: what the agent's folder becomes afterwards does not reach the link.
  writeFileSync(join(pageRoot, 'index.html'), 'changed')
  assert.match((await app.inject({ url: `${base}/runs/1/index.html` })).body, /Piano/)

  // Until the owner refreshes it: same address, new snapshot.
  userId = 'other'
  assert.equal((await app.inject({ method: 'POST', url: `/api/benchmarks/bench/share/${share.id}/refresh` })).statusCode, 404)
  userId = 'owner'
  const refreshed = await app.inject({ method: 'POST', url: `/api/benchmarks/bench/share/${share.id}/refresh` })
  assert.equal(refreshed.statusCode, 200, refreshed.body)
  assert.equal(refreshed.json().id, share.id)
  assert.equal(refreshed.json().url, share.url)
  assert.equal(typeof refreshed.json().refreshedAt, 'number')
  assert.equal((await app.inject({ url: `${base}/runs/1/index.html` })).body, 'changed')
  assert.equal((await app.inject({ url: `${base}/slides.html` })).statusCode, 200)
  assert.deepEqual(readdirNames(join(dir, 'benchmark-shares')), [share.id])
  writeFileSync(join(pageRoot, 'index.html'), '<h1>Piano</h1><script src="keys.js"></script>')

  // A link published before links kept their options can only be replaced.
  db.insert(benchmarkShares).values({ id: 'L'.repeat(32), benchmarkId: 'bench', userId: 'owner', title: 'Old', createdAt: 1, expiresAt: null, revokedAt: null }).run()
  const legacy = await app.inject({ method: 'POST', url: `/api/benchmarks/bench/share/${'L'.repeat(32)}/refresh` })
  assert.equal(legacy.statusCode, 409)
  assert.equal(legacy.json().error.code, 'benchmark_share_not_refreshable')
  assert.equal((await app.inject({ url: '/api/benchmarks/bench/share' })).json().shares.find((link: { id: string }) => link.id === 'L'.repeat(32)).refreshable, false)
  db.delete(benchmarkShares).where(eq(benchmarkShares.id, 'L'.repeat(32))).run()

  // The owner's live rendering: the run folders in place, nothing copied, nothing linked.
  const options = benchmarkShareOptionsSchema.parse({ title: 'Live piano', locale: 'en' })
  const live = await app.inject({ url: benchmarkLiveUrl('bench', 'page', options) })
  assert.equal(live.statusCode, 200, live.body)
  assert.equal(live.headers['content-security-policy'], SHARE_PAGE_CSP)
  assert.equal(live.headers['cache-control'], 'no-store')
  assert.match(live.headers['x-robots-tag'] as string, /noindex/)
  // A live document frames productions through a short-lived stand-in, never the run's own token,
  // and the stand-in serves the same folder.
  const framed = /<iframe src="\/api\/benchmark-previews\/([\w-]+)\/index\.html"/.exec(live.body)
  assert.ok(framed, 'the live page frames the production')
  assert.notEqual(framed[1], 'token-c1')
  assert.doesNotMatch(live.body, /token-c1/)
  assert.equal(runner.previewRoot(framed[1]!), runner.previewRoot('token-c1'))
  assert.equal((await app.inject({ url: `/api/benchmark-previews/${framed[1]}/index.html` })).statusCode, 200)
  assert.doesNotMatch(live.body, /href="\/api\/benchmark-previews/)
  assert.match(live.body, /href="\/api\/benchmarks\/bench\/live\/slides\?options=/)
  const liveSlides = await app.inject({ url: benchmarkLiveUrl('bench', 'slides', options) })
  assert.equal(liveSlides.statusCode, 200)
  assert.match(liveSlides.headers['content-type'] as string, /^text\/html/)
  assert.equal((await app.inject({ url: `/api/benchmarks/bench/live/other?options=${encodeURIComponent(JSON.stringify(options))}` })).statusCode, 404)
  assert.equal((await app.inject({ url: '/api/benchmarks/bench/live/page?options=nope' })).statusCode, 400)
  userId = 'other'
  assert.equal((await app.inject({ url: benchmarkLiveUrl('bench', 'page', options) })).statusCode, 404)
  userId = 'owner'
  assert.deepEqual(readdirNames(join(dir, 'benchmark-shares')), [share.id])

  const archive = await app.inject({ url: `/api/benchmarks/bench/archive?options=${encodeURIComponent(JSON.stringify({ title: 'Piano/battle', blind: true }))}` })
  assert.equal(archive.statusCode, 200)
  assert.match(archive.headers['content-disposition'] as string, /Piano-battle\.zip/)
  const entries = unzipSync(archive.rawPayload)
  assert.deepEqual(Object.keys(entries).sort(), ['index.html', 'runs/1/index.html', 'runs/1/keys.js', 'slides.html'])
  assert.match(Buffer.from(entries['runs/1/index.html']!).toString(), /Piano/)
  assert.match(Buffer.from(entries['index.html']!).toString(), /data-reveal/)
  // Without the slideshow, the archive holds the page alone.
  const pageOnly = unzipSync((await app.inject({ url: `/api/benchmarks/bench/archive?options=${encodeURIComponent(JSON.stringify({ title: 'x', includeSlides: false }))}` })).rawPayload)
  assert.deepEqual(Object.keys(pageOnly).sort(), ['index.html', 'runs/1/index.html', 'runs/1/keys.js'])
  assert.doesNotMatch(Buffer.from(pageOnly['index.html']!).toString(), /slides\.html/)
  // Comments stay private unless asked for, then reach the page and the slides alike.
  assert.doesNotMatch(Buffer.from(pageOnly['index.html']!).toString(), /Private take/)
  const commented = unzipSync((await app.inject({ url: `/api/benchmarks/bench/archive?options=${encodeURIComponent(JSON.stringify({ title: 'x', includeComments: true }))}` })).rawPayload)
  assert.match(Buffer.from(commented['index.html']!).toString(), /Private take on v1/)
  assert.match(Buffer.from(commented['slides.html']!).toString(), /Private take on v1/)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(readdirNames(join(dir, 'benchmark-shares')), [share.id])

  assert.equal((await app.inject({ url: '/api/benchmarks/bench/share' })).json().shares.length, 1)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/benchmarks/bench/share/${share.id}` })).statusCode, 204)
  const gone = await app.inject({ url: `${base}/`, headers: { 'accept-language': 'fr-FR' } })
  assert.equal(gone.statusCode, 404)
  assert.match(gone.body, /plus disponible/)
  assert.equal((await app.inject({ url: `${base}/runs/1/index.html` })).statusCode, 404)
  assert.equal(existsSync(join(dir, 'benchmark-shares', share.id)), false)

  // Expired links stop answering; deleting the benchmark removes what was published for it.
  const again = (await app.inject({ method: 'POST', url: '/api/benchmarks/bench/share', payload: { title: 'Again', expiresAt: Date.now() + 60_000 } })).json()
  assert.equal(existsSync(join(dir, 'benchmark-shares', again.id, 'index.html')), true)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/benchmarks/bench' })).statusCode, 204)
  assert.equal(existsSync(join(dir, 'benchmark-shares', again.id)), false)
  assert.equal((await app.inject({ url: `${BENCHMARK_SHARE_PREFIX}${again.id}/` })).statusCode, 404)

  // Desktop has no public links: nothing is published, nothing is served, the live rendering works.
  const desktop = new BenchmarkShares(ctx, runner, false)
  await assert.rejects(desktop.publish('bench', 'owner', benchmarkShareOptionsSchema.parse({ title: 'x' }), null), /unavailable/i)
  assert.equal(desktop.publicRoot(share.id), null)
  db.insert(benchmarks).values({ id: 'bench2', userId: 'owner', name: 'Desk', prompt: 'p', variants: JSON.stringify(variants), maxDurationMinutes: 10, createdAt: 1, updatedAt: 1 }).run()
  assert.match(await desktop.live('bench2', 'owner', benchmarkShareOptionsSchema.parse({ title: 'Desk' }), 'page'), /<h1>Desk<\/h1>/)
})

function readdirNames(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : []
}

test('benchmark share page: a run a human followed up says so, with what was written, escaped', () => {
  const followUps = [{ text: 'The keys <b>do not</b> play: fix it.', sentAt: Date.UTC(2026, 10, 17) }, { text: 'Now the colors.', sentAt: Date.UTC(2026, 10, 17, 1) }]
  const benchmark = {
    id: 'b', name: 'Piano', prompt: 'Build a piano', variants: dtoVariants, comparisons: [], repetitions: 1, concurrency: 1, maxDurationMinutes: 5, inputs: [],
    checkScript: null, checkTimeoutSeconds: 1, seriesId: null, createdAt: 1, updatedAt: 1,
    runs: [pageRun('r1', 'v1', 60_000, { followUps }), pageRun('r2', 'v2', 95_000)],
  } as unknown as BenchmarkDto
  const html = renderBenchmarkShare(sharePage(benchmark))
  // On the production, in the table and in the chart; the other variant carries nothing.
  assert.equal(html.match(/class="assist" data-follow-ups="2"/g)?.length, 1)
  assert.equal(html.match(/class="assist-line" data-follow-ups="2"/g)?.length, 1)
  assert.match(html, /2 retours humains/)
  assert.match(html, /The keys &lt;b&gt;do not&lt;\/b&gt; play: fix it\./)
  assert.doesNotMatch(html, /<b>do not<\/b>/)
  assert.match(html, /Retour 2 · /)
  assert.match(html, /ses mesures incluent le travail qui a suivi/)
  // Rendered by the server: the pinned script is the one every published page already runs.
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!
  assert.equal(createHash('sha256').update(script).digest('base64'), PAGE_SCRIPT_HASHES[0])
  assert.doesNotMatch(renderBenchmarkShare(sharePage({ ...benchmark, runs: [pageRun('r1', 'v1', 60_000), pageRun('r2', 'v2', 95_000)] } as BenchmarkDto)), /class="(assist|followups)|retour humain/i)
})

test("benchmark share page: the author's comments only when asked for, out of sight on a blind page", () => {
  const benchmark = {
    id: 'b', name: 'Piano', prompt: 'Build a piano', variants: dtoVariants, comparisons: [], repetitions: 1, concurrency: 1, maxDurationMinutes: 5, inputs: [],
    checkScript: null, checkTimeoutSeconds: 1, seriesId: null, createdAt: 1, updatedAt: 1,
    runs: [pageRun('r1', 'v1', 60_000, { ratingNote: 'Opus <b>nailed</b> the keys.' }), pageRun('r2', 'v2', 95_000)],
  } as unknown as BenchmarkDto
  const page = (options: Record<string, unknown>) => renderBenchmarkShare(sharePage(benchmark, { options }))
  // The composition strips the comment unless asked (share.ts): a run without one shows nothing.
  assert.doesNotMatch(renderBenchmarkShare(sharePage({ ...benchmark, runs: [pageRun('r1', 'v1', 60_000), pageRun('r2', 'v2', 95_000)] } as BenchmarkDto)), /data-author-note/)
  const shown = page({ includeComments: true, includeRatings: true })
  assert.match(shown, /<p class="author-note" data-author-note data-label="L’avis de l’auteur · ★★★★☆">Opus &lt;b&gt;nailed&lt;\/b&gt; the keys\.<\/p>/)
  assert.equal(shown.match(/data-author-note/g)!.length, 1)
  const blind = page({ includeComments: true, blind: true })
  assert.doesNotMatch(visibleText(blind), /nailed/)
  assert.match(blind, /data-author-note data-label="[^"]*" data-real="Opus &lt;b&gt;nailed&lt;\/b&gt; the keys\." data-blind=""><\/p>/)
  const script = /<script>([\s\S]*)<\/script>/.exec(shown)![1]!
  assert.equal(createHash('sha256').update(script).digest('base64'), PAGE_SCRIPT_HASHES[0])
})
