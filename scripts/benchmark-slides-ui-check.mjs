import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

// The benchmark slideshow in a real browser: rendered by the server's renderer on fixture runs,
// served with the same policies as a published snapshot (the slideshow's pinned script, the
// productions' sandbox), then driven by keyboard at 1920x1080 and 1280x720. No server or model
// is involved. SLIDES_SHOTS=<dir> chooses where screenshots go; SLIDES_PORT the port (7821 by default).
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const require = createRequire(join(serverDir, 'package.json'))
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href)
const load = (path) => tsImport(pathToFileURL(join(serverDir, path)).href, import.meta.url)
const { renderBenchmarkSlides, SLIDES_SCRIPT_HASHES } = await load('src/benchmarks/share-slides.ts')
const { PREVIEW_POLICY, previewType } = await load('src/benchmarks/deliverables.ts')

const shots = process.env.SLIDES_SHOTS ?? '/var/tmp/sillage-bench-names'
const port = Number(process.env.SLIDES_PORT ?? 7821)
const work = await mkdtemp(join(tmpdir(), 'sillage-slides-'))

// --- Fixture -------------------------------------------------------------------------

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPb/DwADPQGjN4q8xwAAAABJRU5ErkJggg==', 'base64')

function landing(title, ink, paper) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,${paper},#fff);font:24px system-ui;color:${ink}}
h1{font-size:96px;margin:0}.keys{display:flex;gap:6px;margin-top:40px}.keys span{width:60px;height:220px;background:#fff;border:3px solid ${ink};border-radius:0 0 10px 10px}
input{font:inherit;margin-top:30px;padding:10px}</style></head><body><main><h1>${title}</h1><p>A piano that plays.</p>
<div class="keys">${'<span></span>'.repeat(14)}</div><input aria-label="Name" value=""></main></body></html>`
}

const price = (input, output) => ({ input, output, cacheRead: null, cacheWrite: null, cacheWrite1h: null })
const variants = [
  { id: 'v1', label: 'Haiku 5.5', technicalLabel: 'claude-haiku-5-5 · medium', labelIsCustom: false, model: 'claude-haiku-5-5', listPrice: price(0.1, 0.5), config: { agent: 'claude', model: 'haiku', effort: 'medium' } },
  { id: 'v2', label: 'GPT-6.1 Terra', technicalLabel: 'gpt-6.1-terra · medium', labelIsCustom: false, model: 'gpt-6.1-terra', listPrice: price(1, 5), config: { agent: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'medium' } },
  { id: 'v3', label: 'Sonnet 5.5', technicalLabel: 'claude-sonnet-5-5 · medium', labelIsCustom: false, model: 'claude-sonnet-5-5', listPrice: price(2, 10), config: { agent: 'claude', model: 'sonnet', effort: 'medium' } },
  { id: 'v4', label: 'Fable 5.2', technicalLabel: 'claude-fable-5-2 · medium', labelIsCustom: false, model: 'claude-fable-5-2', listPrice: price(8, 40), config: { agent: 'claude', model: 'fable', effort: 'medium' } },
]
const facts = {
  v1: { durationMs: 96_000, costUsd: 0.31, toolCalls: 14, rating: 2 },
  v2: { durationMs: 61_000, costUsd: 0.42, toolCalls: 12, rating: 3 },
  v3: { durationMs: 125_000, costUsd: 2.39, toolCalls: 21, rating: 4 },
  v4: { durationMs: 341_000, costUsd: 9.25, toolCalls: 37, rating: 5 },
}
const runs = variants.map((variant) => ({
  id: `r-${variant.id}`, variantId: variant.id, repetition: 1, conversationId: null, status: 'succeeded', startedAt: 1, finishedAt: 2, error: null,
  cliVersion: variant.config.agent === 'codex' ? '0.163.0' : '2.1.325',
  metrics: {
    version: 2, durationMs: facts[variant.id].durationMs, waitingMs: 0, firstTextMs: 900, inputTokens: 180_000, outputTokens: 12_000,
    cacheReadTokens: 150_000, cacheCreationTokens: 9_000, costUsd: facts[variant.id].costUsd, toolCalls: facts[variant.id].toolCalls, toolsByName: {},
    toolErrors: 0, toolDurationMs: 1000, assistantMessages: 6, outputChars: 1200, contextTokens: null, model: variant.model,
  },
  response: '## Done\n\nThe piano is in `index.html`, with **88 keys** and a sustain pedal.', check: null, files: [], previewToken: null,
  rating: facts[variant.id].rating, ratingNote: null,
}))
const prompt = `${'Build a playable piano as a single static web page, with eighty-eight keys, a sustain pedal and keyboard shortcuts so it can be played without a mouse. '.repeat(4)}\n\nThe page must work offline, from plain files.\n\n${'Detail of the expected behaviour, line after line. '.repeat(30)}`
const benchmark = {
  id: 'b1', name: 'Piano', prompt, variants, repetitions: 1, concurrency: 1, maxDurationMinutes: 20, inputs: [], checkScript: null,
  checkTimeoutSeconds: 60, seriesId: null, createdAt: 1, updatedAt: 1, runs,
  comparisons: [{ id: 'c1', title: null, variantIds: ['v2', 'v3'] }],
}

function options(change) {
  return {
    title: 'Who builds the best piano?', note: 'Four models, one prompt, no help.', includePrompt: true, includeResponses: true,
    includeMetrics: true, includeRatings: true, includeChart: true, includeSlides: true, comparisons: null, blind: false, revealAt: 'each', locale: 'en', ...change,
  }
}

function page(change, order = ['v1', 'v2', 'v3', 'v4']) {
  const shared = runs.map((run) => ({ ...run }))
  return {
    benchmark, options: options(change), order, sharedAt: Date.UTC(2026, 10, 18), live: false,
    // What the composition features, as share.ts computes it: saved comparisons whose contestants are all shown.
    comparisons: benchmark.comparisons.filter((comparison) => comparison.variantIds.every((id) => order.includes(id))),
    links: { page: 'index.html', slides: 'slides.html', exit: 'index.html' },
    runs: [
      { run: shared[0], mode: 'page', reason: null, dir: 'runs/1', entry: 'index.html', files: [], excerpts: {} },
      { run: shared[1], mode: 'files', reason: null, dir: 'runs/2', entry: null, files: [{ path: 'shot.png', sizeBytes: PIXEL.length }], excerpts: {} },
      { run: shared[2], mode: 'none', reason: 'empty', dir: null, entry: null, files: [], excerpts: {} },
      { run: shared[3], mode: 'page', reason: null, dir: 'runs/3', entry: 'index.html', files: [], excerpts: {} },
    ],
  }
}

async function write(dir, document) {
  const base = join(work, dir)
  await mkdir(join(base, 'runs/1'), { recursive: true })
  await mkdir(join(base, 'runs/2'), { recursive: true })
  await mkdir(join(base, 'runs/3'), { recursive: true })
  await writeFile(join(base, 'runs/1/index.html'), landing('Haiku piano', '#1d3557', '#a8dadc'))
  await writeFile(join(base, 'runs/2/shot.png'), PIXEL)
  await writeFile(join(base, 'runs/3/index.html'), landing('Fable piano', '#3d1d57', '#f1c0e8'))
  await writeFile(join(base, 'index.html'), '<!doctype html><title>Page</title><p>The shared page.</p>')
  await writeFile(join(base, 'slides.html'), document)
}
await write('default', renderBenchmarkSlides(page({})))
await write('blind-each', renderBenchmarkSlides(page({ blind: true, revealAt: 'each' })))
await write('blind-end', renderBenchmarkSlides(page({ blind: true, revealAt: 'end' })))

// --- Static host with the snapshot policies --------------------------------------------

const SLIDES_POLICY = `default-src 'none'; style-src 'unsafe-inline'; script-src ${SLIDES_SCRIPT_HASHES.map((hash) => `'sha256-${hash}'`).join(' ')}; ` +
  "img-src 'self' data:; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = join(work, path)
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) { response.writeHead(404).end(); return }
  const isDocument = /\/(slides|index)\.html$/.test(path) && !path.includes('/runs/')
  response.writeHead(200, {
    'content-type': isDocument ? 'text/html; charset=utf-8' : previewType(file),
    'content-security-policy': isDocument ? SLIDES_POLICY : PREVIEW_POLICY,
    'cache-control': 'no-store',
  })
  createReadStream(file).pipe(response)
})
server.listen(port, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${port}`

// --- Checks --------------------------------------------------------------------------

const browser = await chromium.launch()
const problems = []
try {
  for (const [width, height] of [[1920, 1080], [1280, 720]]) {
    const context = await browser.newContext({ viewport: { width, height } })
    const tab = await context.newPage()
    tab.on('console', (message) => { if (message.type() === 'error') problems.push(`${width}: ${message.text()}`) })
    tab.on('pageerror', (error) => problems.push(`${width}: ${error.message}`))
    const hash = () => tab.evaluate(() => location.hash)
    const press = async (key, times = 1) => { for (let i = 0; i < times; i++) await tab.keyboard.press(key) }
    const kinds = await (async () => {
      await tab.goto(`${origin}/default/slides.html`)
      return tab.$$eval('[data-slide]', (slides) => slides.map((slide) => slide.getAttribute('data-kind')))
    })()
    assert.deepEqual(kinds, ['title', 'task', 'lineup', 'production', 'production', 'production', 'production', 'arena', 'scorecard', 'chart', 'chart', 'chart', 'chart', 'chart', 'ranking', 'outro'])
    assert.equal(await hash(), '#/1/1')
    assert.equal(await tab.$eval('html', (node) => node.classList.contains('js')), true, 'the pinned script ran')

    // The stage keeps 16:9 and fills the window.
    const box = await tab.$eval('[data-stage]', (stage) => { const rect = stage.getBoundingClientRect(); return { w: rect.width, h: rect.height } })
    assert.ok(Math.abs(box.w / box.h - 16 / 9) < 0.01 && Math.abs(Math.min(width / box.w, height / box.h) - 1) < 0.02, JSON.stringify(box))

    // Slides fade in: let the animation end, and the controls fade out, before each picture.
    const shoot = async (name) => {
      if (width !== 1920 && !name.startsWith('production') && name !== 'chart') return
      await tab.mouse.move(width - 2, 2)
      await tab.evaluate(() => document.querySelector('[data-hud]')?.classList.remove('on'))
      await tab.waitForTimeout(700)
      await tab.screenshot({ path: join(shots, `forkC-${width}-${name}.png`) })
    }
    await shoot('title')
    await press('ArrowRight')
    assert.equal(await hash(), '#/2/1')
    await shoot('task')
    await press('ArrowRight')
    assert.equal(await hash(), '#/2/2', 'the full prompt is a second step')
    await tab.waitForTimeout(500)
    await shoot('task-full')
    await press('ArrowRight')
    await shoot('lineup')

    // Productions: only the current slide's frames load.
    await press('ArrowRight')
    assert.equal(await hash(), '#/4/1')
    await tab.waitForFunction(() => document.querySelector('.slide.current iframe.loaded') !== null)
    assert.equal(await tab.$$eval('iframe[data-live="1"]', (frames) => frames.length), 1)
    await tab.waitForTimeout(400)
    await shoot('production-page')

    // Keys typed in a production stay there; leaving it gives the keyboard back to the slides.
    const frame = await tab.$('.slide.current iframe')
    const frameBox = await frame.boundingBox()
    await tab.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height * 0.75)
    await press('ArrowRight')
    assert.equal(await hash(), '#/4/1', 'the production keeps the keyboard while the pointer is over it')
    await tab.mouse.move(5, height - 5)
    await tab.waitForTimeout(100)
    await press('ArrowRight')
    assert.equal(await hash(), '#/5/1', 'the slides take the keyboard back')
    assert.equal(await tab.$$eval('iframe[data-live="1"]', (frames) => frames.length), 0, 'the previous production is unloaded')
    await shoot('production-files')
    await press('ArrowRight')
    await shoot('production-message')
    await press('ArrowRight')
    await tab.waitForFunction(() => document.querySelector('.slide.current iframe.loaded') !== null)

    // The band hides with H and the frame takes the room; zoom changes the production's scale.
    const before = await tab.$eval('.slide.current [data-frame]', (node) => node.getBoundingClientRect().height)
    await press('h')
    const after = await tab.$eval('.slide.current [data-frame]', (node) => node.getBoundingClientRect().height)
    assert.ok(after > before, 'the frame grows without the band')
    await press('h')
    const zoom = () => tab.$eval('.slide.current [data-frame]', (node) => getComputedStyle(node).getPropertyValue('--zoom').trim())
    const zoomBefore = Number(await zoom())
    await press('+')
    assert.ok(Math.abs(Number(await zoom()) - zoomBefore - 0.1) < 0.051)
    await press('-')

    await press('ArrowRight')
    await tab.waitForTimeout(500)
    await shoot('arena')
    await press('ArrowRight')
    await press('ArrowRight', 6)
    assert.equal(await tab.$eval('.slide.current .verdict', (node) => node.classList.contains('on')), true)
    await shoot('scorecard')
    await press('ArrowRight')
    await press('ArrowRight', 4)
    await tab.waitForTimeout(1200)
    await shoot('chart')

    // Shift jumps a slide whatever its steps; End and Home reach the ends.
    await press('Shift+ArrowRight')
    assert.match(await hash(), /^#\/11\/1$/)
    await press('End')
    assert.equal(await hash(), `#/${kinds.length}/1`)
    await shoot('outro')
    // Going back lands on the ranking's last step: the whole podium.
    await press('ArrowLeft')
    await tab.waitForTimeout(800)
    assert.equal(await tab.$$eval('.slide.current .place.on', (nodes) => nodes.length), 3)
    await shoot('ranking')
    await press('Home')
    assert.equal(await hash(), '#/1/1')

    // A reload comes back to the same step.
    await tab.goto(`${origin}/default/slides.html#/9/3`)
    await tab.reload()
    assert.equal(await hash(), '#/9/3')
    assert.equal(await tab.$eval('.slide.current', (slide) => slide.getAttribute('data-kind')), 'scorecard')

    // Overview, help and black screen open and close from the keyboard.
    await press('g')
    assert.equal(await tab.$eval('[data-overview]', (node) => node.hidden), false)
    assert.ok((await tab.$$('[data-overview] .ov-item')).length === kinds.length)
    if (width === 1920) { await tab.waitForTimeout(700); await tab.screenshot({ path: join(shots, 'forkC-1920-overview.png') }) }
    await press('Escape')
    assert.equal(await tab.$eval('[data-overview]', (node) => node.hidden), true)
    await press('?')
    assert.equal(await tab.$eval('[data-help]', (node) => node.hidden), false)
    if (width === 1920) { await tab.waitForTimeout(700); await tab.screenshot({ path: join(shots, 'forkC-1920-help.png') }) }
    await press('Escape')
    await press('b')
    assert.equal(await tab.$eval('[data-black]', (node) => node.hidden), false)
    await press('b')
    assert.equal(await tab.$eval('[data-black]', (node) => node.hidden), true)

    // Controls appear with the pointer; clean mode removes them and hides the cursor.
    await tab.mouse.move(width / 2, height / 2)
    await tab.mouse.move(width / 2 + 10, height / 2 + 10)
    assert.equal(await tab.$eval('[data-hud]', (node) => node.classList.contains('on')), true)
    if (width === 1920) await tab.screenshot({ path: join(shots, 'forkC-1920-controls.png') })
    await press('c')
    assert.equal(await tab.$eval('[data-hud]', (node) => getComputedStyle(node).display), 'none')
    await tab.mouse.move(width / 3, height / 3)
    await tab.waitForTimeout(1300)
    assert.equal(await tab.$eval('body', (node) => getComputedStyle(node).cursor), 'none')
    await press('c')

    // Blind, revealed after each production: the name comes on the second step, and goes away again.
    await tab.goto(`${origin}/blind-each/slides.html#/4/1`)
    await tab.reload()
    const name = () => tab.$eval('.slide.current .who .name', (node) => node.innerText.trim())
    assert.equal(await name(), 'Who made this?')
    assert.equal(await tab.$eval('.slide.current .chips', (node) => node.offsetParent === null), true, 'measures wait for the reveal')
    if (width === 1920) { await tab.waitForTimeout(700); await tab.screenshot({ path: join(shots, 'forkC-1920-blind-before.png') }) }
    await press('ArrowRight')
    assert.equal(await name(), 'Haiku 5.5')
    if (width === 1920) { await tab.waitForTimeout(700); await tab.screenshot({ path: join(shots, 'forkC-1920-blind-after.png') }) }
    await press('ArrowLeft')
    assert.equal(await name(), 'Who made this?')
    await press('ArrowLeft')
    assert.ok(!(await tab.$eval('.slide.current', (slide) => slide.innerText)).includes('Haiku'), 'the lineup is letters only before the reveal')
    if (width === 1920) { await tab.waitForTimeout(700); await tab.screenshot({ path: join(shots, 'forkC-1920-blind-lineup.png') }) }

    // Blind, revealed at the end: one card per step on the reveal slide.
    await tab.goto(`${origin}/blind-end/slides.html`)
    const revealIndex = await tab.$$eval('[data-slide]', (slides) => slides.findIndex((slide) => slide.getAttribute('data-kind') === 'reveal') + 1)
    await tab.goto(`${origin}/blind-end/slides.html#/${revealIndex}/3`)
    await tab.reload()
    const cards = await tab.$$eval('.slide.current .card', (nodes) => nodes.map((node) => node.innerText.includes('?') ? '?' : node.querySelector('.name')?.textContent))
    assert.deepEqual(cards, ['Haiku 5.5', 'GPT-6.1 Terra', '?', '?'])
    if (width === 1920) { await tab.waitForTimeout(700); await tab.screenshot({ path: join(shots, 'forkC-1920-reveal.png') }) }
    await tab.goto(`${origin}/blind-end/slides.html#/${revealIndex - 1}/1`)
    await tab.reload()
    if (width === 1920) { await tab.waitForTimeout(700); await tab.screenshot({ path: join(shots, 'forkC-1920-guess.png') }) }

    // Autoplay moves on by itself (the title stays six seconds) and clean=1 starts without controls.
    await tab.goto(`${origin}/default/slides.html?autoplay=1&clean=1`)
    assert.equal(await tab.$eval('html', (node) => node.classList.contains('clean') && node.classList.contains('auto')), true)
    await tab.waitForFunction(() => location.hash === '#/2/1', null, { timeout: 9000 })
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
  await rm(work, { recursive: true, force: true })
}
assert.deepEqual(problems, [], problems.join('\n'))
console.log('benchmark slides UI check passed')
