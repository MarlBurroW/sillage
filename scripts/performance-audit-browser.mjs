import { checkThreadHistory } from './checks/thread-history.mjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Production web/server builds, disposable profiles and real journal copies.
// No CLI is launched. Outputs contain metrics only, never conversation bodies/cookies.
const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = process.env.AUDIT_DIR
if (!scratch) throw new Error('Set AUDIT_DIR to a disposable migrated/seeded directory.')
const ids = process.argv.slice(2)
const resultFile = join(scratch, `${process.env.AUDIT_LABEL ?? 'browser'}-results.json`)
const cpuRate = Number(process.env.AUDIT_CPU_RATE ?? 1)
const profile = process.env.AUDIT_PROFILE ?? 'desktop'
assert.ok(profile === 'desktop' || profile === 'server')
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const config = join(scratch, 'config.toml')
await writeFile(config, ['claude', 'codex', 'opencode', 'grok'].map((cli) => `[agents.${cli}]\nenabled = false\n`).join('\n'))
let serverSession
if (profile === 'server') {
  // Reuse authentication on the synthetic account; never copy production cookies.
  // This optional mode needs Node's tsx loader for the shared session helper.
  const require = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const Database = require('better-sqlite3')
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { createSession } = await import('../apps/server/src/auth/sessions.ts')
  const sqlite = new Database(join(scratch, 'data/sillage.db'))
  try {
    assert.equal(sqlite.prepare('select id from users').all().map((row) => row.id).join(','), 'audit')
    serverSession = (await createSession(drizzle(sqlite), 'audit', 'performance-audit')).token
  } finally { sqlite.close() }
}
const server = spawn(process.execPath, [join(root, 'apps/server/dist/main.js')], {
  cwd: join(root, 'apps/server'),
  env: { ...process.env, NODE_ENV: 'production', SILLAGE_PROFILE: profile, SILLAGE_HANDSHAKE_FD: '3', SILLAGE_HOST: '127.0.0.1', SILLAGE_PORT: String(port), SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(scratch, 'data'), SILLAGE_WEB_ROOT: join(root, 'apps/web/dist') },
  stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
})
let diagnostic = ''
for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-5000) })
const health = []
const results = []
const errors = []
let browser, monitor = true
try {
  const handshake = await Promise.race([
    profile === 'desktop' ? new Promise((resolve) => {
      let text = ''
      server.stdio[3].on('data', (chunk) => { text += chunk; if (text.includes('\n')) resolve(JSON.parse(text.trim())) })
    }) : (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && server.exitCode === null) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`)
          if (response.ok) return { port, session: serverSession }
        } catch { /* Wait for the disposable server's listener. */ }
        await delay(100)
      }
      throw new Error(`Server did not start: ${diagnostic}`)
    })(),
    once(server, 'exit').then(() => { throw new Error(diagnostic) }),
    delay(30000).then(() => { throw new Error(`No handshake: ${diagnostic}`) }),
  ])
  const base = `http://127.0.0.1:${handshake.port}`
  assert.equal((await fetch(`${base}/api/system/instance`).then((response) => response.json())).profile, profile)
  const polling = (async () => {
    while (monitor) {
      const start = performance.now()
      try {
        const row = await fetch(`${base}/api/health`).then((response) => response.json())
        health.push({ at: Date.now(), ms: performance.now() - start, ...row })
      } catch { /* The final sample may overlap shutdown. */ }
      await delay(100)
    }
  })()
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  async function contextFor(viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' })
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)))
    await context.addCookies([{ name: 'sillage_session', value: handshake.session, url: base }])
    await context.addInitScript(() => {
      if (window.top !== window || !['http:', 'https:'].includes(location.protocol)) return
      localStorage.setItem('sillage.locale', 'en')
      window.__audit = { requests: [], longTasks: [], parses: [] }
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__audit.longTasks.push({ start: entry.startTime, ms: entry.duration })
      }).observe({ type: 'longtask', buffered: true })
      const fetchOriginal = window.fetch
      window.fetch = async (...args) => {
        const start = performance.now()
        const response = await fetchOriginal(...args)
        if (/\/(events|thread)\?/.test(String(args[0]))) {
          const record = { url: String(args[0]), start, headersMs: performance.now() - start }
          window.__audit.requests.push(record)
          const originalText = response.text.bind(response)
          response.text = async () => {
            const body = await originalText()
            record.end = performance.now()
            record.chars = body.length
            return body
          }
        }
        return response
      }
      const parse = JSON.parse
      JSON.parse = function (text, ...args) {
        const start = performance.now()
        const value = parse(text, ...args)
        if (typeof text === 'string' && text.length > 1000) window.__audit.parses.push({ chars: text.length, ms: performance.now() - start })
        return value
      }
    })
    return context
  }
  async function metrics(page, cdp, label, started, wallStart) {
    const loadMs = performance.now() - started
    await delay(350)
    const data = await page.evaluate(() => ({ ...window.__audit, resources: performance.getEntriesByType('resource').filter((e) => /\/(events|thread)\?/.test(e.name)).map((e) => ({ duration: e.duration, decoded: e.decodedBodySize, encoded: e.encodedBodySize })), bodyResources: performance.getEntriesByType('resource').filter((e) => /\/events\/\d+\/(images|body)\//.test(e.name)).map((e) => ({ kind: e.name.includes('/images/') ? 'image' : 'body', duration: e.duration, decoded: e.decodedBodySize, encoded: e.encodedBodySize })), heap: performance.memory.usedJSHeapSize, dom: document.querySelectorAll('*').length, threadNodes: document.querySelectorAll('.sg-conversation-width *').length }))
    await cdp.send('HeapProfiler.collectGarbage')
    const heapAfterGc = (await cdp.send('Runtime.getHeapUsage')).usedSize
    const sample = health.filter((entry) => entry.at >= wallStart)
    const result = { label, loadMs, heapAfterGc, ...data, serverMaxRssMb: Math.max(...sample.map((entry) => entry.rssMb)), serverMaxHeapMb: Math.max(...sample.map((entry) => entry.heapUsedMb)), healthMaxMs: Math.max(...sample.map((entry) => entry.ms)) }
    results.push(result)
    console.log(JSON.stringify({ label, loadMs: Math.round(loadMs), heapAfterGcMb: Math.round(heapAfterGc / 1048576), requests: data.requests.length, decodedMb: Math.round(data.resources.reduce((sum, e) => sum + e.decoded, 0) / 1048576), longestTaskMs: Math.max(0, ...data.longTasks.map((entry) => entry.ms)), serverMaxRssMb: result.serverMaxRssMb, healthMaxMs: Math.round(result.healthMaxMs) }))
    await writeFile(resultFile, JSON.stringify({ cpuRate, results, health }, null, 2))
  }
  const context = await contextFor()
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate })
  for (const [index, id] of [...ids, ids[0], ids[1]].entries()) {
    const started = performance.now(), wallStart = Date.now()
    const route = `/p/audit/c/${id}`
    if (index === 0) await page.goto(base + route)
    else {
      await page.evaluate(() => { window.__audit = { requests: [], longTasks: [], parses: [] }; performance.clearResourceTimings() })
      await page.locator(`a[href="${route}"]`).first().click()
    }
    await page.waitForURL(base + route)
    await page.waitForFunction((id) => window.__audit.requests.some((e) => e.url.includes(id)), id)
    await page.locator('.sg-conversation-width.opacity-100').waitFor({ timeout: 120000 })
    await metrics(page, cdp, `${index >= ids.length ? 'warm' : 'cold'}-${id.slice(0, 8)}`, started, wallStart)
  }
  console.log(JSON.stringify({ pageErrors: errors }))
  const cycleHeaps = []
  for (let cycle = 0; cycle < Number(process.env.AUDIT_CYCLES ?? 0); cycle++) {
    const id = ids[cycle % ids.length]
    await page.locator(`a[href="/p/audit/c/${id}"]`).first().click()
    await page.waitForURL(`${base}/p/audit/c/${id}`)
    await page.locator('.sg-conversation-width.opacity-100').waitFor()
    await delay(150)
    await cdp.send('HeapProfiler.collectGarbage')
    cycleHeaps.push((await cdp.send('Runtime.getHeapUsage')).usedSize)
  }
  if (cycleHeaps.length) {
    results.push({ label: 'navigation-cycles', heapAfterGc: cycleHeaps })
    console.log(JSON.stringify({ cycles: cycleHeaps.length, heapMiB: cycleHeaps.map((n) => Math.round(n / 1048576 * 10) / 10) }))
  }
  await context.close()

  // Navigate away during replay. A cancelled view must not keep requesting pages.
  const cancellation = await contextFor()
  const cancelledPage = await cancellation.newPage()
  await cancelledPage.goto(`${base}/p/audit/c/${ids[0]}`)
  await cancelledPage.waitForResponse((r) => r.url().includes(`/conversations/${ids[0]}/`) && /\/(events|thread)\?/.test(r.url()))
  await cancelledPage.locator('a[href="/settings"]').first().click()
  await cancelledPage.waitForURL((url) => url.pathname.startsWith('/settings'))
  const atSwitch = await cancelledPage.evaluate(() => performance.now())
  await delay(6000)
  const cancelled = await cancelledPage.evaluate(({ id, atSwitch }) => ({ all: window.__audit.requests.filter((e) => e.url.includes(id)), afterSwitch: window.__audit.requests.filter((e) => e.url.includes(id) && e.start > atSwitch).length }), { id: ids[0], atSwitch })
  console.log(JSON.stringify({ cancelledReplay: cancelled.afterSwitch, totalPages: cancelled.all.length }))
  results.push({ label: 'navigation-away', ...cancelled })
  await cancellation.close()

  const mobile = await contextFor({ width: 390, height: 844 })
  const mobilePage = await mobile.newPage()
  const mobileCdp = await mobile.newCDPSession(mobilePage)
  await mobileCdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate })
  const started = performance.now(), wallStart = Date.now()
  await mobilePage.goto(`${base}/p/audit/c/${ids[1]}`)
  await mobilePage.locator('.sg-conversation-width.opacity-100').waitFor({ timeout: 120000 })
  await metrics(mobilePage, mobileCdp, 'mobile-cold-images', started, wallStart)
  if (process.env.AUDIT_HISTORY === '1') await checkThreadHistory(mobilePage, base, ids[1], ids[0])
  await mobile.close()
  if (process.env.AUDIT_HISTORY === '1') {
    const historyContext = await contextFor()
    const historyPage = await historyContext.newPage()
    await historyPage.goto(`${base}/p/audit/c/${ids[0]}`)
    await historyPage.locator('.sg-conversation-width.opacity-100').waitFor()
    await checkThreadHistory(historyPage, base, ids[0], ids[1])
    await historyContext.close()
  }
  assert.deepEqual(errors, [], 'No renderer errors across all viewports')
  monitor = false
  await polling
  await writeFile(resultFile, JSON.stringify({ profile, node: process.version, chromium: browser.version(), cpuRate, results, health, errors }, null, 2))
} finally {
  monitor = false
  await browser?.close()
  if (server.exitCode === null) {
    if (profile === 'desktop') server.stdin.end()
    else server.kill('SIGTERM')
    await Promise.race([once(server, 'exit'), delay(15000).then(() => { if (server.exitCode === null) server.kill('SIGKILL') })])
  }
}
