import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AGENT_MARKS, benchmarkShareOptionsSchema, type BenchmarkDto, type BenchmarkRunDto, type BenchmarkShareOptions } from '@sillage/protocol'
import type { SharePage, SharePageRun } from '../src/benchmarks/share-page.js'
import { SLIDES_SCRIPT, SLIDES_SCRIPT_HASHES, promptSummary, renderBenchmarkSlides } from '../src/benchmarks/share-slides.js'

const price = (input: number, output: number) => ({ input, output, cacheRead: null, cacheWrite: null, cacheWrite1h: null })

const variants = [
  {
    id: 'v1', label: 'Opus 5.5', technicalLabel: 'claude-opus-5-5 · medium', labelIsCustom: false, model: 'claude-opus-5-5', listPrice: price(4, 20),
    config: { agent: 'claude', model: 'opus', effort: 'medium' },
  },
  {
    id: 'v2', label: 'GPT-6.1 Terra', technicalLabel: 'gpt-6.1-terra · medium', labelIsCustom: false, model: 'gpt-6.1-terra', listPrice: price(1, 5),
    config: { agent: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'medium' },
  },
  {
    id: 'v3', label: 'Sonnet 5.5', technicalLabel: 'claude-sonnet-5-5 · medium', labelIsCustom: false, model: 'claude-sonnet-5-5', listPrice: price(2, 10),
    config: { agent: 'claude', model: 'sonnet', effort: 'medium' },
  },
]

// Distinct durations, so a leaked measure is recognisable: 3 min 07 s, 1 min 01 s, 2 min 05 s.
const DURATIONS: Record<string, number> = { v1: 187_000, v2: 61_000, v3: 125_000 }
const COSTS: Record<string, number> = { v1: 6.93, v2: 0.42, v3: 2.39 }
const RATINGS: Record<string, number> = { v1: 5, v2: 3, v3: 4 }

function run(variantId: string, overrides: Partial<BenchmarkRunDto> = {}): BenchmarkRunDto {
  return {
    id: `r-${variantId}`, variantId, repetition: 1, conversationId: null, status: 'succeeded', startedAt: 1, finishedAt: 2, error: null,
    cliVersion: variantId === 'v2' ? '0.163.0' : '2.1.325',
    metrics: {
      version: 2, durationMs: DURATIONS[variantId]!, waitingMs: 0, firstTextMs: 900, inputTokens: 120_000, outputTokens: 9_000,
      cacheReadTokens: 100_000, cacheCreationTokens: 5_000, costUsd: COSTS[variantId]!, toolCalls: variantId === 'v1' ? 37 : 12,
      toolsByName: {}, toolErrors: 0, toolDurationMs: 1000, assistantMessages: 4, outputChars: 900, contextTokens: null, model: null,
    },
    response: '**Done** <img src=x onerror=alert(1)>', check: null, files: [], previewToken: null, rating: RATINGS[variantId]!, ratingNote: null,
    ...overrides,
  }
}

const benchmark = {
  id: 'b1', name: 'Piano', prompt: 'Build a piano page.', variants, repetitions: 1, concurrency: 1, maxDurationMinutes: 20, inputs: [],
  checkScript: null, checkTimeoutSeconds: 60, seriesId: null, createdAt: 1, updatedAt: 1,
  comparisons: [{ id: 'c1', title: null, variantIds: ['v2', 'v3'] }],
  runs: ['v1', 'v2', 'v3'].map((id) => run(id)),
} as unknown as BenchmarkDto

function pageOf(options: Partial<BenchmarkShareOptions> = {}, extra: { order?: string[]; live?: boolean; prompt?: string } = {}): SharePage {
  const parsed = benchmarkShareOptionsSchema.parse({ title: 'Piano duel', locale: 'fr', ...options })
  const root = (n: number) => (extra.live ? `/api/benchmark-previews/token-${n}` : `runs/${n}`)
  const runs: SharePageRun[] = [
    { run: benchmark.runs[0]!, mode: 'page', reason: null, dir: root(1), entry: 'index.html', files: [], excerpts: {} },
    { run: benchmark.runs[1]!, mode: 'files', reason: null, dir: root(2), entry: null, files: [{ path: 'shot.png', sizeBytes: 10 }], excerpts: {} },
    { run: benchmark.runs[2]!, mode: 'none', reason: 'empty', dir: null, entry: null, files: [], excerpts: {} },
  ].map((item) => (parsed.includeRatings ? item : { ...item, run: { ...item.run, rating: null } })) as SharePageRun[]
  return {
    benchmark: { ...benchmark, prompt: extra.prompt ?? benchmark.prompt },
    options: parsed,
    runs,
    order: extra.order ?? ['v1', 'v2', 'v3'],
    sharedAt: Date.UTC(2026, 10, 18),
    live: extra.live ?? false,
    // What the composition features: every saved comparison, as the share window leaves it.
    comparisons: (parsed.comparisons === null ? benchmark.comparisons : benchmark.comparisons.filter((entry) => parsed.comparisons!.includes(entry.id)))
      .filter((entry) => entry.variantIds.every((id) => (extra.order ?? ['v1', 'v2', 'v3']).includes(id))),
    links: extra.live
      ? { page: '/api/benchmarks/b1/live/page?options=x', slides: '/api/benchmarks/b1/live/slides?options=x', exit: '/api/benchmarks/b1/live/page?options=x' }
      : { page: 'index.html', slides: 'slides.html', exit: 'index.html' },
  }
}

interface Section { kind: string; steps: number; base: number; body: string }

function sections(html: string): Section[] {
  return [...html.matchAll(/<section class="slide s-[\w-]+" data-slide data-kind="([\w-]+)" data-steps="(\d+)" data-dwell="[^"]*" data-base="(\d+)">([\s\S]*?)<\/section>/g)]
    .map((match) => ({ kind: match[1]!, steps: Number(match[2]), base: Number(match[3]), body: match[4]! }))
}

/** What a slide shows at a position: wrappers hidden at that position are dropped, as the script hides them. */
function visibleAt(body: string, position: number): string {
  return body
    .replace(/<sg-reveal data-at="(\d+)" hidden>([\s\S]*?)<\/sg-reveal>/g, (_, at: string, inner: string) => (position >= Number(at) ? inner : ''))
    .replace(/<sg-conceal data-at="(\d+)">([\s\S]*?)<\/sg-conceal>/g, (_, at: string, inner: string) => (position < Number(at) ? inner : ''))
}

const durationText: Record<string, string> = { v1: '3 min 07 s', v2: '1 min 01 s', v3: '2 min 05 s' }

/**
 * Before a variant's reveal, no slide may show its name, its model, its measures; before the
 * first reveal, no CLI name or mark either. The guessing slide lists names on purpose, in an
 * order that says nothing about letters.
 */
function assertBlind(html: string) {
  const all = sections(html)
  // Every wrapper holding a variant's name opens at the same position: its reveal.
  const revealAt = (id: string) => {
    const label = variants.find((v) => v.id === id)!.label
    const positions = [...html.matchAll(/<sg-reveal data-at="(\d+)" hidden>([\s\S]*?)<\/sg-reveal>/g)]
      .filter((match) => match[2]!.includes(`>${label}<`)).map((match) => Number(match[1]))
    assert.ok(positions.length > 0, `no reveal for ${id}`)
    assert.equal(new Set(positions).size, 1, `${id} is revealed at several positions`)
    return positions[0]!
  }
  const reveal = Object.fromEntries(variants.map((v) => [v.id, revealAt(v.id)]))
  const first = Math.min(...Object.values(reveal))
  for (const section of all) {
    if (section.kind === 'guess') continue
    for (let step = 0; step < section.steps; step++) {
      const position = section.base + step
      const visible = visibleAt(section.body, position)
      for (const variant of variants) {
        if (position >= reveal[variant.id]!) continue
        for (const leak of [variant.label, variant.technicalLabel, variant.model, durationText[variant.id]!]) {
          assert.ok(!visible.includes(leak), `${section.kind} at ${position} shows ${leak} before ${reveal[variant.id]}`)
        }
      }
      if (position < first) {
        for (const leak of ['Claude Code', 'Codex', AGENT_MARKS.claude.paths[0]!.d.slice(0, 24), AGENT_MARKS.codex.paths[0]!.d.slice(0, 24)]) {
          assert.ok(!visible.includes(leak), `${section.kind} at ${position} shows ${leak}`)
        }
      }
    }
  }
  return reveal
}

test('slides: one pinned script, the data block escaped, user text escaped', () => {
  const lineSeparator = String.fromCharCode(0x2028)
  // In the middle: titles are trimmed, and the separator counts as white space.
  const html = renderBenchmarkSlides(pageOf({ title: `Piano </script><script>alert(1)</script>${lineSeparator}duel`, note: '<b>bold</b>' }))
  const scripts = [...html.matchAll(/<script( [^>]*)?>([\s\S]*?)<\/script>/g)]
  const executable = scripts.filter((match) => !match[1])
  assert.equal(executable.length, 1)
  assert.equal(executable[0]![2], SLIDES_SCRIPT)
  assert.equal(createHash('sha256').update(SLIDES_SCRIPT).digest('base64'), SLIDES_SCRIPT_HASHES[0])
  const data = scripts.find((match) => match[1]?.includes('application/json'))![2]!
  assert.ok(!data.includes('</script'))
  assert.ok(data.includes('\\' + 'u003c/script'))
  assert.ok(!data.includes(lineSeparator))
  assert.ok(data.includes('\\' + 'u2028'))
  assert.deepEqual(JSON.parse(data).slides[0].title, `Piano </script><script>alert(1)</script>${lineSeparator}duel`)
  assert.ok(html.includes('<h1 class="headline">Piano &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'))
  // An agent's message is rendered as Markdown without its raw HTML.
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('<strong>Done</strong>'))
  // No title attribute: their tooltips would end up in a recording.
  assert.ok(!/\stitle="/.test(html))
})

test('slides: the story follows the benchmark order and its measures', () => {
  const html = renderBenchmarkSlides(pageOf({}, { order: ['v3', 'v1', 'v2'] }))
  const all = sections(html)
  assert.deepEqual(all.map((section) => section.kind), [
    'title', 'task', 'lineup', 'production', 'production', 'production', 'arena', 'scorecard',
    'chart', 'chart', 'chart', 'chart', 'ranking', 'outro',
  ])
  const productions = all.filter((section) => section.kind === 'production')
  assert.deepEqual(productions.map((section) => /<span>([^<]+)<\/span><\/p>/.exec(section.body)?.[1]), ['Sonnet 5.5', 'Opus 5.5', 'GPT-6.1 Terra'])
  assert.deepEqual(productions.map((section) => /<span class="letter">(\w)<\/span>/.exec(section.body)?.[1]), ['A', 'B', 'C'])
  // Positions run over every step: bases follow the step counts.
  for (let index = 1; index < all.length; index++) assert.equal(all[index]!.base, all[index - 1]!.base + all[index - 1]!.steps)
  // A page is embedded live, files as a gallery, a run without production by its message.
  assert.match(productions[1]!.body, /<iframe data-src="runs\/1\/index\.html" sandbox="allow-scripts allow-forms allow-pointer-lock"/)
  assert.ok(!html.includes('allow-popups') && !html.includes('allow-modals') && !html.includes('allow-same-origin'))
  assert.match(productions[2]!.body, /<img src="runs\/2\/shot\.png"/)
  assert.match(productions[0]!.body, /class="message" data-scroll/)
  // Measures in the band: the first variant's time; records along the way (Terra, faster than both before it).
  assert.ok(productions[0]!.body.includes('2 min 05 s'))
  assert.ok(productions[2]!.body.includes('Le plus rapide jusqu’ici'))
  assert.ok(!productions[0]!.body.includes('class="tag"'))
  // Directional charts rank best first and reveal from the last place up.
  const time = all.find((section) => section.kind === 'chart')!
  assert.equal(time.steps, 4)
  const rows = [...time.body.matchAll(/<li class="bar-row([^"]*)" data-step="(\d+)"[^>]*><span class="rank">(\d*)<\/span>[\s\S]*?<span class="name">([^<]+)<\/span>/g)]
  assert.deepEqual(rows.map((row) => [row[4], row[3], row[2]]), [['GPT-6.1 Terra', '1', '3'], ['Sonnet 5.5', '2', '2'], ['Opus 5.5', '3', '1']])
  assert.match(rows[0]![1]!, /best/)
  // Without ratings shared, the ranking is by time: Terra first.
  const ranking = all.find((section) => section.kind === 'ranking')!
  assert.ok(ranking.body.includes('Selon la durée'))
  assert.match(ranking.body, /<div class="place p1 st" data-step="\d+"><span class="rank">1<\/span><p class="name"><span class="mark">[\s\S]*?<span>GPT-6.1 Terra<\/span>/)
  assert.ok(html.includes('Claude Code 2.1.325 · Codex 0.163.0'))
})

test('slides: ratings rank when shared, and a production that did not finish cannot win', () => {
  const rated = renderBenchmarkSlides(pageOf({ includeRatings: true }))
  const ranking = sections(rated).find((section) => section.kind === 'ranking')!
  assert.ok(ranking.body.includes('Selon la note'))
  assert.match(ranking.body, /<div class="place p1 st"[^>]*><span class="rank">1<\/span><p class="name"><span class="mark">[\s\S]*?<span>Opus 5.5<\/span>/)
  assert.ok(sections(rated).some((section) => section.kind === 'chart' && section.body.includes('Note')))

  const failed = pageOf()
  failed.runs[1] = { ...failed.runs[1]!, run: { ...failed.runs[1]!.run, status: 'failed' } }
  const html = renderBenchmarkSlides(failed)
  const time = sections(html).find((section) => section.kind === 'chart')!
  const segment = time.body.split('<li class="bar-row').find((part) => part.includes('<span class="name">GPT-6.1 Terra</span>'))!
  const terra = /^([^"]*)"[^>]*><span class="rank">(\d*)<\/span>[\s\S]*?<span class="value([^"]*)">([^<]*)<\/span>/.exec(segment)!
  assert.match(terra[1]!, /out/)
  assert.equal(terra[2], '')
  assert.match(terra[4]!, /Échec/)
  assert.ok(sections(html).find((section) => section.kind === 'production' && section.body.includes('GPT-6.1 Terra'))!.body.includes('class="status"'))
})

test('slides: blind, revealed after each production; going back hides again', () => {
  const html = renderBenchmarkSlides(pageOf({ blind: true, revealAt: 'each' }))
  const reveal = assertBlind(html)
  const all = sections(html)
  for (const section of all.filter((entry) => entry.kind === 'production')) {
    assert.equal(section.steps, 2)
    const shown = visibleAt(section.body, section.base + 1)
    const variant = variants.find((entry) => shown.includes(entry.label))!
    assert.equal(reveal[variant.id], section.base + 1)
    assert.ok(visibleAt(section.body, section.base).includes('Qui a fait ça ?'))
    assert.ok(shown.includes(durationText[variant.id]!))
  }
  // Frames are named by letter, never by model.
  assert.match(html, /aria-label="Variante A"><\/iframe>/)
  assert.ok(!all.some((section) => section.kind === 'reveal' || section.kind === 'guess'))
  // The overview names a slide only from its reveal position on.
  const data = JSON.parse(/<script type="application\/json" id="slides-data">([\s\S]*?)<\/script>/.exec(html)![1]!)
  const entry = data.slides.find((slide: { title: string }) => slide.title === 'A · Opus 5.5')
  assert.deepEqual(entry, { title: 'A · Opus 5.5', blind: 'Variante A', at: reveal.v1 })
})

test('slides: blind, revealed all at the end, one card per step', () => {
  const html = renderBenchmarkSlides(pageOf({ blind: true, revealAt: 'end' }))
  const reveal = assertBlind(html)
  const all = sections(html)
  const revealSlide = all.find((section) => section.kind === 'reveal')!
  assert.equal(revealSlide.steps, variants.length + 1)
  assert.deepEqual(Object.values(reveal), [1, 2, 3].map((step) => revealSlide.base + step))
  assert.ok(all.filter((section) => section.kind === 'production').every((section) => section.steps === 1))
  // The guessing slide lists the candidates alphabetically, so the list says nothing about letters.
  const guess = all.find((section) => section.kind === 'guess')!
  assert.deepEqual([...guess.body.matchAll(/<li><span class="mark">[\s\S]*?<\/span><span>([^<]+)<\/span><\/li>/g)].map((match) => match[1]), ['GPT-6.1 Terra', 'Opus 5.5', 'Sonnet 5.5'])
  assert.ok(all.findIndex((section) => section.kind === 'reveal') < all.findIndex((section) => section.kind === 'arena'))
})

test('slides: live rendering embeds the run folders and links no preview', () => {
  const html = renderBenchmarkSlides(pageOf({}, { live: true }))
  // Live, closing hands the window back to the app instead of loading the app into it.
  assert.match(html, /<a href="\/api\/benchmarks\/b1\/live\/page\?options=x" data-exit data-close/)
  // A copy's exit is a plain link to its page (the script itself names the attribute, so match the link).
  assert.match(renderBenchmarkSlides(pageOf()), /<a href="index\.html" data-exit aria-label=/)
  assert.match(html, /<iframe data-src="\/api\/benchmark-previews\/token-1\/index\.html"/)
  assert.match(html, /<img src="\/api\/benchmark-previews\/token-2\/shot\.png"/)
  assert.ok(!/href="[^"]*benchmark-previews/.test(html))
  assert.ok(html.includes('href="/api/benchmarks/b1/live/page?options=x" data-exit'))
  assert.ok(html.includes('class="pagelink" href="/api/benchmarks/b1/live/page?options=x"'))
})

test('slides: featured comparisons become an arena and a scorecard', () => {
  const all = sections(renderBenchmarkSlides(pageOf()))
  const arena = all.find((section) => section.kind === 'arena')!
  assert.ok(arena.body.includes('GPT-6.1 Terra vs Sonnet 5.5'))
  assert.equal([...arena.body.matchAll(/<figure class="lane">/g)].length, 2)
  assert.ok(arena.body.includes('class="vs"'))
  const score = all.find((section) => section.kind === 'scorecard')!
  // Time, cost, tokens and tool calls; Terra wins both measures that have a direction.
  assert.equal(score.steps, 4 + 2)
  assert.match(score.body, /<td class="win">1 min 01 s<\/td>/)
  assert.ok(score.body.includes('GPT-6.1 Terra remporte 2 mesures sur 2'))

  assert.ok(!sections(renderBenchmarkSlides(pageOf({ comparisons: [] }))).some((section) => section.kind === 'arena'))
  const hidden = pageOf({}, { order: ['v1', 'v2'] })
  assert.ok(!sections(renderBenchmarkSlides(hidden)).some((section) => section.kind === 'arena'), 'a comparison needs two shown variants')
})

test('slides: without measurements, no numbers anywhere', () => {
  const html = renderBenchmarkSlides(pageOf({ includeMetrics: false, includeResponses: false }))
  const kinds = sections(html).map((section) => section.kind)
  assert.ok(!kinds.includes('chart') && !kinds.includes('scorecard') && !kinds.includes('ranking'))
  assert.ok(!html.includes('class="chips"'))
  assert.ok(!html.includes('3 min 07 s'))
  assert.ok(!html.includes('<strong>Done</strong>'))
})

test('slides: a long prompt is summed up first, then shown whole', () => {
  const long = `${'Build a piano with eighty-eight keys and a sustain pedal. '.repeat(12)}\n\nThen add a metronome.`
  assert.equal(promptSummary(long).truncated, true)
  assert.ok(promptSummary(long).summary.length <= 401)
  assert.ok(promptSummary(long).summary.endsWith('…'))
  assert.deepEqual(promptSummary('Short task.'), { summary: 'Short task.', truncated: false })
  const task = sections(renderBenchmarkSlides(pageOf({}, { prompt: long }))).find((section) => section.kind === 'task')!
  assert.equal(task.steps, 2)
  assert.match(task.body, /<pre class="prompt-full mono swap" data-step="1" data-scroll>/)
  const rules = sections(renderBenchmarkSlides(pageOf({ includePrompt: false }))).find((section) => section.kind === 'task')!
  assert.ok(rules.body.includes('Les règles') && !rules.body.includes('Build a piano'))
})
