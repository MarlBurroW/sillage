import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { unzipSync } from 'fflate'
import { benchmarkRuns, benchmarks, conversations, openDatabase, personalWorkspaces, runMigrations, users } from '@sillage/db'
import { BENCHMARK_SHARE_PREFIX, benchmarkShareOptionsSchema, type BenchmarkDto } from '@sillage/protocol'
import { assessRunFolder, pageNeedsBuild } from '../src/benchmarks/exportability.js'
import { BenchmarkRunner } from '../src/benchmarks/runner.js'
import { SHARE_PAGE_CSP, renderBenchmarkShare } from '../src/benchmarks/share-page.js'
import { BenchmarkShares } from '../src/benchmarks/share.js'
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

test('benchmark share page: pinned script, escaped content, blind names out of sight', () => {
  const run = (id: string, variantId: string, durationMs: number) => ({
    id, variantId, repetition: 1, conversationId: null, status: 'succeeded' as const, startedAt: 1, finishedAt: 2, error: null, cliVersion: '1',
    metrics: metrics(durationMs, 0.5), response: '**Done** <img src=x onerror=alert(1)> [local](file:///etc) [web](https://example.com)',
    check: null, files: [], previewToken: null, rating: 4, ratingNote: null,
  })
  const benchmark = {
    id: 'b', name: 'Piano', prompt: 'Build a <piano>', variants, repetitions: 1, concurrency: 1, maxDurationMinutes: 5, inputs: [],
    checkScript: null, checkTimeoutSeconds: 1, seriesId: null, createdAt: 1, updatedAt: 1, runs: [run('r1', 'v1', 60_000), run('r2', 'v2', 95_000)],
  } as unknown as BenchmarkDto
  const page = (blind: boolean) => renderBenchmarkShare({
    benchmark, order: ['v1', 'v2'], sharedAt: Date.UTC(2026, 10, 16),
    options: benchmarkShareOptionsSchema.parse({ title: 'Piano <battle>', blind, locale: 'fr' }),
    runs: [
      { run: benchmark.runs[0]!, mode: 'page', reason: null, dir: 'runs/1', entry: 'my page/index.html', files: [], excerpts: {} },
      { run: benchmark.runs[1]!, mode: 'none', reason: 'build', dir: null, entry: null, files: [], excerpts: {} },
    ],
  })
  const html = page(false)
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!
  assert.ok(SHARE_PAGE_CSP.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`))
  assert.match(html, /<h1>Piano &lt;battle&gt;<\/h1>/)
  assert.match(html, /Build a &lt;piano&gt;/)
  assert.match(html, /Opus &lt;b&gt;max&lt;\/b&gt;/)
  assert.doesNotMatch(html, /<img src=x/)
  assert.doesNotMatch(html, /href="file:/)
  assert.match(html, /href="https:\/\/example\.com" target="_blank"/)
  assert.match(html, /<iframe src="runs\/1\/my%20page\/index\.html" sandbox="allow-scripts[^"]*"/)
  assert.doesNotMatch(html, /allow-same-origin/)
  assert.match(html, /étape de build/)
  // The faster variant leads its column; ratings stay private unless asked for.
  assert.match(html, /<td class="best">1 min/)
  assert.doesNotMatch(html, /\/ 5</)

  const blind = page(true)
  const visible = blind.replace(/data-real="[^"]*"/g, '').replace(/<script>[\s\S]*<\/script>/, '')
  assert.doesNotMatch(visible, /Opus|Terra|Claude Code|Codex/)
  assert.match(blind, /data-real="Terra high" data-blind="Variante B">Variante B</)
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
      metrics: JSON.stringify(metrics(variantId === 'v1' ? 30_000 : 90_000, null)), response: `Answer of ${variantId}`, previewToken: `token-${id}`, rating: 5,
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

  // Frozen: what the agent's folder becomes afterwards does not reach the link.
  writeFileSync(join(pageRoot, 'index.html'), 'changed')
  assert.match((await app.inject({ url: `${base}/runs/1/index.html` })).body, /Piano/)

  const archive = await app.inject({ url: `/api/benchmarks/bench/archive?options=${encodeURIComponent(JSON.stringify({ title: 'Piano/battle', blind: true }))}` })
  assert.equal(archive.statusCode, 200)
  assert.match(archive.headers['content-disposition'] as string, /Piano-battle\.zip/)
  const entries = unzipSync(archive.rawPayload)
  assert.deepEqual(Object.keys(entries).sort(), ['index.html', 'runs/1/index.html', 'runs/1/keys.js'])
  assert.equal(Buffer.from(entries['runs/1/index.html']!).toString(), 'changed')
  assert.match(Buffer.from(entries['index.html']!).toString(), /data-reveal/)
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

  // Desktop has no public links: nothing is published, nothing is served.
  const desktop = new BenchmarkShares(ctx, runner, false)
  await assert.rejects(desktop.publish('bench', 'owner', benchmarkShareOptionsSchema.parse({ title: 'x' }), null), /unavailable/i)
  assert.equal(desktop.publicRoot(share.id), null)
})

function readdirNames(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : []
}
