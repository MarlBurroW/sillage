import { createHash } from 'node:crypto'
import {
  agentMarkSvg,
  compareVariants,
  deliverableKind,
  distanceFromBest,
  eligibleRuns,
  median,
  niceCeiling,
  rankValues,
  runTotalTokens,
  variantAgent,
  variantEffort,
  variantMeasure,
  type AgentKind,
  type BenchmarkComparison,
  type BenchmarkRunDto,
  type BenchmarkVariantDto,
} from '@sillage/protocol'
import { exportText } from '../exports/labels.js'
import { agents, escapeHtml } from '../exports/render.js'
import type { SharePage, SharePageRun } from './share-page.js'
import { encodePath, fill, formatters, jsonBlock, letterOf, messageRenderer } from './share-parts.js'
import { SLIDES_SCRIPT } from './share-slides-script.js'
import { SLIDES_CSS } from './share-slides-style.js'

/**
 * The slideshow a benchmark leaves Sillage as, beside its shared page: made to be screen-shared
 * or recorded for a video. Same composition as the page (`SharePage`), so the variants, their
 * order, their letters on a blind publication and their numbers are the page's.
 *
 * The story follows the benchmark's order, which the author sets worst to best for suspense:
 * title, task, contestants, one live production per model, the featured comparisons, one chart
 * per measure, the ranking, how it was measured.
 */

export { SLIDES_SCRIPT }

/**
 * Hashes of every slideshow script a published `slides.html` may carry, current first. Append
 * the previous hash whenever the script changes: snapshots keep the script they were written with.
 */
export const SLIDES_SCRIPT_HASHES: string[] = [createHash('sha256').update(SLIDES_SCRIPT).digest('base64')]

/**
 * Narrower than the page's: a production that opens a dialog or a window would freeze or cover
 * the slideshow in the middle of a take.
 */
const SLIDE_FRAME_SANDBOX = 'allow-scripts allow-forms allow-pointer-lock'

/** Productions are drawn at this width and scaled to their frame: native size reads too small on a phone watching the video. */
const PRODUCTION_WIDTH = 1440
const ARENA_WIDTH = 1280
const FRAME_WIDTH = 1920 - 2 * 96

/** Seconds per step when the slideshow plays by itself. */
const DWELL = {
  title: [6], task: [9, 14], lineup: [8], production: [18], blindProduction: [12, 8], guess: [10],
  reveal: 3, arena: [16], scoreRow: 2.5, verdict: 5, chartBar: 1.3, outro: [10],
}

const logoPath = 'M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79ZM23 79C47 79 39 21 65 21H78C54 21 62 79 36 79ZM42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z'
const logo = (size: number) => `<svg viewBox="0 0 100 100" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${logoPath}"/></svg>`

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
const ICONS = {
  previous: icon('<path d="m15 18-6-6 6-6"/>'),
  next: icon('<path d="m9 18 6-6-6-6"/>'),
  overview: icon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  band: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18"/>'),
  autoplay: icon('<path d="m7 4 12 8-12 8V4z"/>'),
  clean: icon('<path d="M9.9 9.9a3 3 0 1 0 4.2 4.2"/><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7"/><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/>'),
  fullscreen: icon('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  help: icon('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  reply: icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m10 7-3 3 3 3"/><path d="M17 13v-1a2 2 0 0 0-2-2H7"/>'),
}

/** A follow-up quoted over its production: two lines on screen, the rest stays on the page. */
const QUOTE_CHARS = 180

type ChartKey = 'durationMs' | 'costUsd' | 'tokens' | 'toolCalls' | 'rating' | 'passRate'

interface Measure {
  median: number | null
  /** Whether the value may rank: it comes from runs that succeeded (and passed the check). */
  eligible: boolean
}

interface Contestant {
  id: string
  index: number
  letter: string
  variant: BenchmarkVariantDto
  agent: AgentKind
  cli: string
  effort: string | null
  runs: SharePageRun[]
  /** The run whose production the slides show: one that can be shown, succeeded, rated best. */
  shown: SharePageRun | null
  /** Position from which the variant's name may be read; 0 when the publication is not blind. */
  revealAt: number
}

interface SlideSpec {
  kind: string
  steps: number
  dwell: number[]
  /** For the overview: the real title, and on blind publications the one shown until `at`. */
  title: string
  blind?: { title: string; at: () => number }
  body: (base: number) => string
}

const MODE_RANK = { page: 0, files: 1, none: 2 } as const

function representative(runs: SharePageRun[]): SharePageRun | null {
  return [...runs].sort((a, b) =>
    MODE_RANK[a.mode] - MODE_RANK[b.mode]
    || Number(b.run.status === 'succeeded') - Number(a.run.status === 'succeeded')
    || (b.run.rating ?? -1) - (a.run.rating ?? -1)
    || a.run.repetition - b.run.repetition)[0] ?? null
}

/** The first paragraph, cut at a word near `max`: real prompts run to thousands of characters. */
export function promptSummary(prompt: string, max = 400): { summary: string; truncated: boolean } {
  const whole = prompt.trim()
  const first = (whole.split(/\n\s*\n/)[0] ?? '').trim()
  if (first.length <= max) return { summary: first, truncated: first.length < whole.length }
  const cut = first.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return { summary: `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`, truncated: true }
}

export function renderBenchmarkSlides(page: SharePage): string {
  const { benchmark, options } = page
  const t = exportText(options.locale)
  const e = escapeHtml
  const f = formatters(options.locale)
  const md = messageRenderer()
  const blind = options.blind
  const metrics = options.includeMetrics
  const percent = new Intl.NumberFormat(options.locale, { style: 'percent', maximumFractionDigits: 0 })
  const price = new Intl.NumberFormat(options.locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0, maximumFractionDigits: 2 })
  const factor = (value: number) => `×${new Intl.NumberFormat(options.locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)}`

  // Numbers come from the runs as published: ratings are already left out when not shared.
  const pool: { runs: BenchmarkRunDto[]; checkScript: string | null } = { runs: page.runs.map((item) => item.run), checkScript: benchmark.checkScript }
  const rated = options.includeRatings && pool.runs.some((run) => run.rating !== null)
  const checked = Boolean(benchmark.checkScript) && pool.runs.some((run) => run.check !== null)

  const contestants: Contestant[] = page.order
    .map((id) => benchmark.variants.find((variant) => variant.id === id))
    .filter((variant): variant is BenchmarkVariantDto => !!variant)
    .map((variant, index) => {
      const runs = page.runs.filter((item) => item.run.variantId === variant.id)
      const agent = variantAgent(variant)
      return {
        id: variant.id, index, letter: letterOf(index), variant, agent, cli: agents[agent], effort: variantEffort(variant.config),
        runs, shown: representative(runs), revealAt: 0,
      }
    })
  const total = contestants.length

  function measure(id: string, key: ChartKey): Measure {
    if (key === 'tokens') {
      const runs = pool.runs.filter((run) => run.variantId === id)
      const eligible = eligibleRuns(pool, runs)
      const values = (eligible.length ? eligible : runs).map(runTotalTokens)
      const value = median(values)
      return { median: value, eligible: eligible.length > 0 && value !== null }
    }
    const result = variantMeasure(pool, id, key)
    return { median: result.median, eligible: result.eligible }
  }
  const directionOf = (key: ChartKey): 'lower' | 'higher' | null =>
    key === 'durationMs' || key === 'costUsd' ? 'lower' : key === 'rating' || key === 'passRate' ? 'higher' : null
  const labelOf = (key: ChartKey): string => ({
    durationMs: t('export.bench.col.duration'), costUsd: t('export.bench.col.cost'), tokens: t('export.bench.col.tokens'),
    toolCalls: t('export.bench.col.tools'), rating: t('export.bench.col.rating'), passRate: t('export.slides.passRate'),
  })[key]
  const format = (key: ChartKey, value: number): string => {
    switch (key) {
      case 'durationMs': return f.duration(value)
      case 'costUsd': return f.cost(value)
      case 'tokens': return f.tokens(value)
      case 'toolCalls': return f.number(value)
      case 'rating': return `${f.number(value)}/5`
      case 'passRate': return percent.format(value)
    }
  }
  // Measures a chart, a scorecard or the ranking may show, in reading order.
  const measures: ChartKey[] = metrics
    ? ['durationMs', 'costUsd', 'tokens', 'toolCalls', ...(rated ? ['rating' as const] : []), ...(checked ? ['passRate' as const] : [])]
    : []

  // --- Blind publications --------------------------------------------------------

  /** Shown only from the variant's reveal position on; never in the visible text before. */
  const revealed = (c: Contestant, html: string) => (blind ? `<sg-reveal data-at="${c.revealAt}" hidden>${html}</sg-reveal>` : html)
  /** What stands in the place of the name until then. */
  const named = (c: Contestant, html: string, placeholder: string) =>
    blind ? `<sg-conceal data-at="${c.revealAt}">${placeholder}</sg-conceal>${revealed(c, html)}` : html
  const mark = (c: Contestant, size: number) => `<span class="mark">${agentMarkSvg(c.agent, size)}</span>`
  const letterBadge = (c: Contestant) => `<span class="letter">${e(c.letter)}</span>`
  const variantWord = (c: Contestant) => fill(t('export.bench.variant'), { letter: c.letter })
  const nameOf = (c: Contestant) => e(c.variant.label)
  // A result a human had to correct says so on every slide that names it: the video stays honest.
  const followUpsOf = (c: Contestant) => c.runs.reduce((total, item) => total + item.run.followUps.length, 0)
  const followUpText = (count: number) => fill(t(count === 1 ? 'export.bench.followUps.one' : 'export.bench.followUps'), { count })
  const assistMini = (c: Contestant) => {
    const count = followUpsOf(c)
    return count ? ` <span class="assist-mini" title="${e(followUpText(count))}">${ICONS.reply}${count}</span>` : ''
  }

  // --- Pieces --------------------------------------------------------------------

  const empty = (text: string) => `<div class="frame"><div class="empty"><p>${e(text)}</p></div></div>`

  function gallery(item: SharePageRun): string {
    const files = item.files.filter((file) => ['image', 'video', 'audio', 'text'].includes(deliverableKind(file.path))).slice(0, 4)
    if (!files.length || !item.dir) return empty(t('export.slides.noProduction'))
    const figures = files.map((file) => {
      const url = e(`${item.dir}/${encodePath(file.path)}`)
      const caption = `<figcaption>${e(file.path)}</figcaption>`
      switch (deliverableKind(file.path)) {
        case 'image': return `<figure><img src="${url}" alt="" loading="lazy">${caption}</figure>`
        case 'video': return `<figure><video src="${url}" controls preload="metadata"></video>${caption}</figure>`
        case 'audio': return `<figure><audio src="${url}" controls preload="metadata"></audio>${caption}</figure>`
        default: return `<figure><pre>${e(item.excerpts[file.path] ?? '')}</pre>${caption}</figure>`
      }
    })
    return `<div class="frame" data-frame><div class="gallery g${files.length}">${figures.join('')}</div></div>`
  }

  /** What the variant made: its page live, its files, or its final message, in a frame. */
  function production(c: Contestant, width: number, frameWidth: number): string {
    const item = c.shown
    if (!item) return empty(t('export.slides.noProduction'))
    if (item.mode === 'page' && item.dir && item.entry) {
      const label = blind ? variantWord(c) : c.variant.label
      return `<div class="frame" data-frame style="--zoom:${Math.round((frameWidth / width) * 1000) / 1000}">` +
        `<iframe data-src="${e(`${item.dir}/${encodePath(item.entry)}`)}" sandbox="${SLIDE_FRAME_SANDBOX}" referrerpolicy="no-referrer" aria-label="${e(label)}"></iframe></div>`
    }
    if (item.mode === 'files') return gallery(item)
    if (options.includeResponses && item.run.response) {
      return `<div class="frame" data-frame><div class="message" data-scroll>${md.render(item.run.response)}</div></div>`
    }
    const reason = item.reason && !(item.reason === 'empty' && item.run.response) ? item.reason : null
    return empty(reason ? t(`export.bench.blocked.${reason}`) : t('export.slides.noProduction'))
  }

  // Records along the way: a model faster or cheaper than every one shown before it. Records,
  // not ranks, so they give the video moments without spoiling the ending.
  const records = new Map<string, string[]>()
  if (metrics) {
    for (const [key, label] of [['durationMs', t('export.slides.record.fastest')], ['costUsd', t('export.slides.record.cheapest')]] as const) {
      let best: number | null = null
      for (const c of contestants) {
        const value = measure(c.id, key)
        if (!value.eligible || value.median === null) continue
        if (best !== null && value.median < best) records.set(c.id, [...(records.get(c.id) ?? []), label])
        best = best === null ? value.median : Math.min(best, value.median)
      }
    }
  }

  function chips(c: Contestant): string {
    if (!metrics) return ''
    const value = (key: ChartKey) => {
      const result = measure(c.id, key)
      return result.median === null ? '—' : format(key, result.median)
    }
    const chip = (label: string, text: string, tone = '') => `<li class="chip"><span class="k">${e(label)}</span><span class="v${tone}">${e(text)}</span></li>`
    const list = [
      chip(t('export.bench.col.duration'), value('durationMs')),
      chip(t('export.bench.col.cost'), value('costUsd')),
      chip(t('export.bench.col.tools'), value('toolCalls')),
    ]
    if (benchmark.checkScript) {
      const runs = c.runs.map((item) => item.run).filter((run) => run.check)
      const passed = runs.filter((run) => run.check!.passed).length
      if (runs.length) {
        // The chip is already titled Check: its value says only how it went.
        const text = runs.length === 1 ? (passed ? `✓ ${t('export.slides.check.passed')}` : `✗ ${t('export.slides.check.failed')}`) : `${passed === runs.length ? '✓' : '✗'} ${passed}/${runs.length}`
        list.push(chip(t('export.bench.col.check'), text, passed === runs.length ? ' pass' : ' fail'))
      }
    }
    if (rated) {
      const rating = measure(c.id, 'rating')
      if (rating.median !== null) list.push(chip(t('export.bench.col.rating'), `★ ${format('rating', rating.median)}`))
    }
    // The count lets the band tighten its numbers when ratings and the check join the three measures.
    return `<ul class="chips" data-count="${list.length}">${list.join('')}</ul>`
  }

  function band(c: Contestant): string {
    const status = c.shown && ['failed', 'timed_out', 'cancelled'].includes(c.shown.run.status)
      ? `<span class="status">${e(t(`export.bench.status.${c.shown.run.status as 'failed' | 'timed_out' | 'cancelled'}`))}</span>` : ''
    const runCount = c.runs.length
    const run = c.shown && runCount > 1 ? `<span>${e(fill(t('export.slides.run'), { n: c.shown.run.repetition, total: runCount }))}</span>` : ''
    const tags = (records.get(c.id) ?? []).map((label) => `<span class="tag">▲ ${e(label)}</span>`).join('')
    const count = c.shown?.run.followUps.length ?? 0
    const assist = count ? `<span class="assist" data-follow-ups="${count}">${ICONS.reply}${e(followUpText(count))}</span>` : ''
    const line = `<span>${e(c.cli)}${c.effort ? ` · ${e(c.effort)}` : ''}</span>${run}${status}${assist}${tags}`
    return `<div class="band" data-band><div class="badge">${letterBadge(c)}<span class="count">${c.index + 1} / ${total}</span></div>` +
      // Its length sizes the name to the room the measures leave (see .who .name).
      `<div class="who"><p class="name" style="--chars:${Math.max(6, [...c.variant.label].length)}">${named(c, `${mark(c, 56)}<span>${nameOf(c)}</span>`, e(t('export.slides.guess')))}</p>` +
      `<p class="line">${named(c, line, e(variantWord(c)))}</p></div>${revealed(c, chips(c))}</div>`
  }

  const clip = (raw: string) => {
    const flat = raw.replace(/\s+/g, ' ').trim()
    return flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS - 1).trimEnd()}…` : flat
  }

  /** Captions over the bottom of a production: the follow-up it needed, then the author's take. */
  function overlays(c: Contestant): string {
    const parts = followUpQuote(c) + authorQuote(c)
    return parts ? `<div class="overlays">${parts}</div>` : ''
  }

  /** The author's comment on the run shown. It may name the model, so a blind slide waits for the reveal. */
  function authorQuote(c: Contestant): string {
    const run = c.shown?.run
    if (!run?.ratingNote) return ''
    const stars = run.rating !== null ? `<span class="stars">${'★'.repeat(run.rating)}${'☆'.repeat(5 - run.rating)}</span>` : ''
    return revealed(c, `<p class="author-quote" data-author-quote><span class="k">${e(t('export.slides.comment'))}${stars}</span><q>${e(clip(run.ratingNote))}</q></p>`)
  }

  /** What the human wrote to the run shown. */
  function followUpQuote(c: Contestant): string {
    const followUps = c.shown?.run.followUps ?? []
    if (followUps.length === 0) return ''
    const text = clip(followUps[followUps.length - 1]!.text)
    const more = followUps.length > 1 ? `<span class="more">${e(followUpText(followUps.length))}</span>` : ''
    return `<p class="assist-quote" data-follow-up-quote><span class="k">${ICONS.reply}${e(t('export.slides.followUp'))}</span><q>${e(text)}</q>${more}</p>`
  }

  function card(c: Contestant, dense: boolean): string {
    const known = c.variant.listPrice
    const cost = known
      ? `<p class="price">${e(price.format(known.input))} / ${e(price.format(known.output))}</p>`
      : `<p class="price unknown">${e(t('export.slides.noPrice'))}</p>`
    const details = `<p class="name">${nameOf(c)}</p><p class="sub">${e(c.cli)}${c.effort ? ` · ${e(c.effort)}` : ''}</p>` +
      `<p class="sub mono">${e(c.variant.model ?? c.variant.technicalLabel)}</p>${cost}`
    return `<li class="card">` +
      `<div class="card-top">${letterBadge(c)}${named(c, mark(c, dense ? 36 : 48), '<span class="qmark">?</span>')}</div>` +
      `${named(c, details, '')}</li>`
  }
  const cardColumns = (count: number) => (count <= 1 ? 1 : count <= 2 ? 2 : count <= 3 ? 3 : count <= 12 ? 4 : 6)

  // --- Slides --------------------------------------------------------------------

  const specs: SlideSpec[] = []
  const section = (spec: SlideSpec, base: number) =>
    `<section class="slide s-${spec.kind}" data-slide data-kind="${spec.kind}" data-steps="${spec.steps}" data-dwell="${spec.dwell.join(',')}" data-base="${base}">${spec.body(base)}</section>`

  const clis = new Set(contestants.map((c) => c.agent)).size
  specs.push({
    kind: 'title', steps: 1, dwell: DWELL.title, title: options.title,
    body: () => `<div class="wake" aria-hidden="true">${logo(980)}</div>` +
      `<p class="kicker">${e(t('export.bench.kicker'))}</p><h1 class="headline">${e(options.title)}</h1>` +
      (options.note ? `<p class="subtitle">${e(options.note)}</p>` : '') +
      `<ul class="facts"><li>${e(t('export.slides.prompt'))}</li>` +
      `<li>${e(total === 1 ? t('export.slides.model') : fill(t('export.slides.models'), { count: total }))}</li>` +
      `<li>${e(clis === 1 ? t('export.slides.cli') : fill(t('export.slides.clis'), { count: clis }))}</li></ul>` +
      `<p class="brandline">${logo(34)}<span>Sillage · ${e(f.date(page.sharedAt))}</span></p>`,
  })

  const method = [
    t('export.slides.method.fresh'),
    fill(t('export.slides.method.duration'), { minutes: benchmark.maxDurationMinutes }),
    benchmark.repetitions === 1 ? t('export.slides.method.run') : fill(t('export.slides.method.runs'), { count: benchmark.repetitions }),
    ...(benchmark.inputs.length ? [benchmark.inputs.length === 1 ? t('export.slides.method.file') : fill(t('export.slides.method.files'), { count: benchmark.inputs.length })] : []),
    ...(benchmark.checkScript ? [t('export.slides.method.check')] : []),
  ]
  const chipsRow = `<ul class="chips-row">${method.map((text) => `<li>${e(text)}</li>`).join('')}</ul>`
  if (options.includePrompt) {
    const { summary, truncated } = promptSummary(benchmark.prompt)
    specs.push({
      kind: 'task', steps: truncated ? 2 : 1, dwell: DWELL.task, title: t('export.slides.task'),
      body: () => `<div class="slide-head"><h2 class="slide-title">${e(t('export.slides.task'))}</h2></div>` +
        (truncated
          ? `<p class="summary swap" data-until="1">${e(summary)}</p>` +
            `<pre class="prompt-full mono swap" data-step="1" data-scroll>${e(benchmark.prompt)}</pre>`
          : `<p class="summary">${e(summary)}</p>`) + chipsRow,
    })
  } else {
    specs.push({
      kind: 'task', steps: 1, dwell: DWELL.title, title: t('export.slides.rules'),
      body: () => `<div class="slide-head"><h2 class="slide-title">${e(t('export.slides.rules'))}</h2></div>${chipsRow}`,
    })
  }

  if (total > 0) {
    const dense = total > 8
    specs.push({
      kind: 'lineup', steps: 1, dwell: DWELL.lineup, title: t('export.slides.lineup'),
      body: () => `<div class="slide-head"><h2 class="slide-title">${e(t('export.slides.lineup'))}</h2></div>` +
        `<ul class="cards c${cardColumns(total)}${dense ? ' dense' : total <= 4 ? ' few' : ''}">${contestants.map((c) => card(c, dense)).join('')}</ul>` +
        // Prices tell tiers apart, so a blind lineup keeps them for the reveal.
        (!blind && contestants.some((c) => c.variant.listPrice) ? `<p class="legend">${e(t('export.slides.priceLegend'))}</p>` : ''),
    })
  }

  // One slide per production. On a blind publication revealed after each one, the slide has a
  // second step that names the model.
  const eachReveal = blind && options.revealAt === 'each'
  const productionSpecs = new Map<string, SlideSpec>()
  for (const c of contestants) {
    const spec: SlideSpec = {
      kind: 'production', steps: eachReveal ? 2 : 1, dwell: eachReveal ? DWELL.blindProduction : DWELL.production,
      title: `${c.letter} · ${c.variant.label}`,
      ...(blind ? { blind: { title: variantWord(c), at: () => c.revealAt } } : {}),
      body: () => production(c, PRODUCTION_WIDTH, FRAME_WIDTH) + overlays(c) + band(c),
    }
    productionSpecs.set(c.id, spec)
    specs.push(spec)
  }

  // Revealing everything at the end: first a guessing moment with the candidates in alphabetical
  // order (which says nothing about who is who), then one card per step.
  let revealSpec: SlideSpec | null = null
  if (blind && !eachReveal && total > 0) {
    const names = [...new Map(contestants.map((c) => [c.variant.label, c])).values()]
      .sort((a, b) => a.variant.label.localeCompare(b.variant.label, options.locale))
    specs.push({
      kind: 'guess', steps: 1, dwell: DWELL.guess, title: t('export.slides.guessTitle'),
      body: () => `<div class="slide-head"><div><h2 class="slide-title">${e(t('export.slides.guessTitle'))}</h2><p class="hint">${e(t('export.slides.guessHint'))}</p></div></div>` +
        `<div class="guess"><ul class="letters">${contestants.map((c) => `<li>${letterBadge(c)}</li>`).join('')}</ul>` +
        `<ul class="names">${names.map((c) => `<li>${mark(c, 40)}<span>${nameOf(c)}</span></li>`).join('')}</ul></div>`,
    })
    revealSpec = {
      kind: 'reveal', steps: total + 1, dwell: [DWELL.reveal], title: t('export.slides.revealTitle'),
      body: () => `<div class="slide-head"><h2 class="slide-title">${e(t('export.slides.revealTitle'))}</h2></div>` +
        `<ul class="cards c${cardColumns(total)}${total > 8 ? ' dense' : total <= 4 ? ' few' : ''}">${contestants.map((c) => card(c, total > 8)).join('')}</ul>`,
    }
    specs.push(revealSpec)
  }

  // Featured comparisons as the composition chose them, so the page and its slides list the same
  // duels in the same order.
  const featured: BenchmarkComparison[] = page.comparisons
  for (const comparison of featured) {
    const lanes = comparison.variantIds.map((id) => contestants.find((c) => c.id === id)!)
    const title = comparison.title || lanes.map((c) => c.variant.label).join(` ${t('export.slides.vs')} `)
    const revealAt = () => Math.max(...lanes.map((c) => c.revealAt))
    const blindTitle = lanes.map((c) => c.letter).join(` ${t('export.slides.vs')} `)
    const laneWidth = lanes.length === 3 ? (FRAME_WIDTH - 48) / 3 : (FRAME_WIDTH - 24) / 2
    specs.push({
      kind: 'arena', steps: 1, dwell: DWELL.arena, title, ...(blind ? { blind: { title: blindTitle, at: revealAt } } : {}),
      body: () => `<div class="slide-head"><h2 class="slide-title">${e(title)}</h2></div>` +
        `<div class="arena a${lanes.length}">${lanes.map((c) => `<figure class="lane">${production(c, lanes.length === 3 ? 1024 : ARENA_WIDTH, laneWidth)}` +
          `<figcaption>${letterBadge(c)}${mark(c, 40)}<span>${nameOf(c)}</span></figcaption></figure>`).join('')}` +
        (lanes.length === 2 ? `<span class="vs" aria-hidden="true">${e(t('export.slides.vs').toUpperCase())}</span>` : '') + '</div>',
    })
    if (!metrics) continue
    const keys = measures.filter((key) => lanes.some((c) => measure(c.id, key).median !== null))
    const compared = compareVariants(pool, comparison.variantIds, keys.filter((key): key is Exclude<ChartKey, 'tokens'> => key !== 'tokens'))
    const rows = keys.map((key) => {
      const direction = directionOf(key)
      const row = compared.find((entry) => entry.key === key)
      const values = lanes.map((c) => measure(c.id, key))
      return { key, direction, values, best: row?.best ?? null, winner: row?.winner ?? null }
    })
    const contested = rows.filter((row) => row.direction && row.values.filter((value) => value.eligible && value.median !== null).length >= 2)
    const wins = lanes.map((c) => contested.filter((row) => row.winner === c.id).length)
    const top = Math.max(0, ...wins)
    const leaders = lanes.filter((_, index) => wins[index] === top)
    const verdict = contested.length === 0 ? null
      : top > 0 && leaders.length === 1
        ? fill(t('export.slides.wins'), { name: leaders[0]!.variant.label, wins: top, total: contested.length })
        : t('export.slides.tie')
    specs.push({
      kind: 'scorecard', steps: rows.length + (verdict ? 2 : 1), dwell: [DWELL.scoreRow, ...rows.map(() => DWELL.scoreRow), DWELL.verdict],
      title: `${t('export.slides.scorecard')} · ${title}`,
      ...(blind ? { blind: { title: `${t('export.slides.scorecard')} · ${blindTitle}`, at: revealAt } } : {}),
      body: () => `<div class="slide-head"><div><h2 class="slide-title">${e(title)}</h2><p class="hint">${e(t('export.slides.scorecard'))}</p></div></div>` +
        `<table class="score"><thead><tr><th></th>${lanes.map((c) => `<th><span class="head">${letterBadge(c)}${mark(c, 36)}<span>${nameOf(c)}</span></span></th>`).join('')}</tr></thead><tbody>` +
        rows.map((row, index) => `<tr class="st" data-step="${index + 1}"><th>${e(labelOf(row.key))}` +
          (row.direction ? `<small>${e(t(row.direction === 'lower' ? 'export.slides.lowerBetter' : 'export.slides.higherBetter'))}</small>` : '') + '</th>' +
          row.values.map((value, lane) => {
            if (value.median === null) return '<td>—</td>'
            const winner = row.winner === lanes[lane]!.id
            const distance = row.direction && !winner && value.eligible ? distanceFromBest(row.key === 'tokens' ? 'inputTokens' : row.key, value.median, row.best) : null
            const gap = distance?.factor && distance.factor >= 1.05 ? `<small>${e(factor(distance.factor))}</small>`
              : distance && row.key === 'rating' && distance.difference ? `<small>${e(f.number(distance.difference))}</small>` : ''
            const failed = !value.eligible ? `<small>${e(t('export.bench.status.failed'))}</small>` : ''
            return `<td${winner ? ' class="win"' : ''}>${e(format(row.key, value.median))}${gap}${failed}</td>`
          }).join('') + '</tr>').join('') +
        `</tbody></table>${verdict ? `<p class="verdict st" data-step="${rows.length + 1}">${e(verdict)}</p>` : ''}`,
    })
  }

  // One chart per measure. Measures with a direction rank best first and reveal from the last
  // place up, so the winner comes last; the others keep the benchmark's order.
  for (const key of measures) {
    const values = contestants.map((c) => ({ c, value: measure(c.id, key) }))
    const known = values.filter((entry) => entry.value.median !== null)
    if (known.length < 2) continue
    const direction = directionOf(key)
    const ranks = direction ? rankValues(values.map((entry) => (entry.value.eligible ? entry.value.median : null)), direction) : values.map(() => null)
    const rows = values.map((entry, index) => ({ ...entry, rank: ranks[index] ?? null }))
    if (direction) {
      rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || Number(b.value.median !== null) - Number(a.value.median !== null) || a.c.index - b.c.index)
    }
    // Durations round to minutes or seconds, so the axis reads 10 min rather than 8 min 20 s.
    const highest = Math.max(...known.map((entry) => entry.value.median!))
    const unit = key === 'durationMs' ? (highest >= 60_000 ? 60_000 : 1000) : 1
    const ceiling = niceCeiling(highest / unit) * unit
    const width = (value: number) => (ceiling > 0 ? Math.max(0.5, (value / ceiling) * 100) : 0)
    const dense = rows.length > 12
    const few = rows.length <= 6
    const hints = [
      direction ? t(direction === 'lower' ? 'export.slides.lowerBetter' : 'export.slides.higherBetter') : null,
      key === 'tokens' ? t('export.slides.tokensHint') : null,
      benchmark.repetitions > 1 ? fill(t('export.slides.median'), { count: benchmark.repetitions }) : null,
    ].filter(Boolean).join(' · ')
    const steps = direction ? rows.length + 1 : 1
    specs.push({
      kind: 'chart', steps, dwell: direction ? [DWELL.chartBar * 1.5, ...rows.map(() => DWELL.chartBar)] : [8], title: labelOf(key),
      body: () => `<div class="slide-head"><div><h2 class="slide-title">${e(labelOf(key))}</h2>${hints ? `<p class="hint">${e(hints)}</p>` : ''}</div></div>` +
        `<div class="chart-body"><ol class="bars${dense ? ' dense' : few ? ' few' : ''}">` + rows.map((row, index) => {
          const value = row.value.median
          const out = value !== null && !row.value.eligible
          const classes = ['bar-row', 'st', row.rank === 1 && direction ? 'best' : '', out ? 'out' : ''].filter(Boolean).join(' ')
          const step = direction ? rows.length - index : 0
          return `<li class="${classes}" data-step="${step}" style="--w:${value === null ? 0 : width(value).toFixed(2)}%">` +
            `<span class="rank">${row.rank ?? ''}</span>${letterBadge(row.c)}${mark(row.c, dense ? 28 : 36)}<span class="name">${nameOf(row.c)}${assistMini(row.c)}</span>` +
            `<span class="track"><span class="fill"></span></span>` +
            `<span class="value${out ? ' out' : ''}">${value === null ? '—' : e(format(key, value))}${out ? ` · ${e(t('export.bench.status.failed'))}` : ''}</span></li>`
        }).join('') + '</ol>' +
        `<div class="axis"><span class="ticks">${[0, ceiling / 2, ceiling].map((tick, index) =>
          `<span style="left:${(tick / (ceiling || 1)) * 100}%;transform:translateX(${index === 0 ? '0' : index === 2 ? '-100%' : '-50%'})">${tick === 0 ? '0' : e(format(key, tick))}</span>`).join('')}</span></div></div>`,
    })
  }

  // The ranking: by rating when the author shared ratings, otherwise by time. Places from the
  // fourth on appear together, then the podium from third to first.
  // Without the measurements the page shows no numbers, ratings included: the slides follow it.
  const criterion: ChartKey | null = !metrics ? null : rated ? 'rating' : 'durationMs'
  if (criterion && total > 1) {
    const direction = directionOf(criterion)!
    const values = contestants.map((c) => ({ c, value: measure(c.id, criterion) }))
    const ranks = rankValues(values.map((entry) => (entry.value.eligible ? entry.value.median : null)), direction)
    const ordered = values.map((entry, index) => ({ ...entry, rank: ranks[index] ?? null }))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.c.index - b.c.index)
    const podium = ordered.filter((entry) => entry.rank !== null).slice(0, 3)
    const rest = ordered.filter((entry) => !podium.includes(entry))
    if (podium.length > 0) {
      let step = 1
      const restStep = rest.length ? step++ : 0
      const placeSteps = [2, 1, 0].filter((index) => podium[index]).reduce<Record<number, number>>((all, index) => ({ ...all, [index]: step++ }), {})
      const place = (index: number) => {
        const entry = podium[index]
        if (!entry) return '<div></div>'
        return `<div class="place p${index + 1} st" data-step="${placeSteps[index]}"><span class="rank">${entry.rank}</span>` +
          `<p class="name">${mark(entry.c, 40)}<span>${nameOf(entry.c)}</span>${assistMini(entry.c)}</p><p class="value">${e(format(criterion, entry.value.median!))}</p></div>`
      }
      specs.push({
        kind: 'ranking', steps: step, dwell: [3, ...Array.from({ length: step - 1 }, (_, index) => (index === step - 2 ? 8 : 3))],
        title: t('export.slides.ranking'),
        body: () => `<div class="slide-head"><div><h2 class="slide-title">${e(t('export.slides.ranking'))}</h2>` +
          `<p class="hint">${e(t(criterion === 'rating' ? 'export.slides.rankingBy.rating' : 'export.slides.rankingBy.duration'))}</p></div></div>` +
          // Alone, the podium takes the middle; a long list of the others shares the width with it.
          `<div class="ranking${rest.length === 0 ? ' solo' : rest.length > 8 ? ' crowded' : ''}"><div class="podium">${place(1)}${place(0)}${place(2)}</div>` +
          (rest.length ? `<ol class="rest st${rest.length > 8 ? ' dense' : ''}" data-step="${restStep}">${rest.map((entry) =>
            `<li><span class="rank">${entry.rank ?? '—'}</span>${mark(entry.c, 32)}<span class="name">${nameOf(entry.c)}${assistMini(entry.c)}</span>` +
            `<span class="value">${entry.rank === null ? e(t('export.slides.notRanked')) : e(format(criterion, entry.value.median!))}</span></li>`).join('')}</ol>` : '') +
          '</div>',
      })
    }
  }

  const versions = [...new Set(contestants.map((c) => c.agent))].map((agent) => {
    const found = [...new Set(page.runs.filter((item) => contestants.some((c) => c.id === item.run.variantId && c.agent === agent)).map((item) => item.run.cliVersion).filter((value): value is string => !!value))]
    return found.length ? `${agents[agent]} ${found.join(', ')}` : null
  }).filter(Boolean)
  specs.push({
    kind: 'outro', steps: 1, dwell: DWELL.outro, title: t('export.slides.outro'),
    body: () => `<h2 class="slide-title">${e(t('export.slides.outro'))}</h2><div style="height:40px"></div>` +
      `<p class="outro-text">${e(fill(t('export.slides.outro.method'), { minutes: benchmark.maxDurationMinutes }))}</p>` +
      (metrics ? `<p class="outro-text">${e(t('export.slides.outro.median'))}</p><p class="outro-text">${e(t('export.slides.outro.cost'))}</p>` : '') +
      (contestants.some((c) => followUpsOf(c) > 0) ? `<p class="outro-text">${e(t('export.bench.followUpNote'))}</p>` : '') +
      (versions.length ? `<p class="versions">${e(t('export.slides.outro.versions'))} · ${e(versions.join(' · '))}</p>` : '') +
      `<a class="pagelink" href="${e(page.links.page)}">${e(t('export.slides.outro.page'))}</a>` +
      `<p class="brandline">${logo(34)}<span>${e(t('export.page.signature'))}</span></p>`,
  })

  // --- Positions ---------------------------------------------------------------------

  const bases: number[] = []
  let position = 0
  for (const spec of specs) {
    bases.push(position)
    position += spec.steps
  }
  if (blind) {
    for (const c of contestants) {
      c.revealAt = eachReveal
        ? bases[specs.indexOf(productionSpecs.get(c.id)!)]! + 1
        : bases[specs.indexOf(revealSpec!)]! + 1 + c.index
    }
  }

  const data = {
    slides: specs.map((spec) => (spec.blind ? { title: spec.title, blind: spec.blind.title, at: spec.blind.at() } : { title: spec.title })),
  }

  const help: [string, string][] = [
    ['→ · Space · PageDown · Enter', t('export.slides.help.next')],
    ['← · Shift+Space · PageUp · Backspace', t('export.slides.help.previous')],
    ['Shift + → / ←', t('export.slides.help.slide')],
    ['Home / End', t('export.slides.help.ends')],
    ['↓ / ↑', t('export.slides.help.scroll')],
    ['G', t('export.slides.hud.overview')],
    ['F · F5', t('export.slides.help.fullscreen')],
    ['C', t('export.slides.help.clean')],
    ['B · .', t('export.slides.help.black')],
    ['H', t('export.slides.help.band')],
    ['R', t('export.slides.help.reload')],
    ['+ / −', t('export.slides.help.zoom')],
    ['A', t('export.slides.help.autoplay')],
    ['?', t('export.slides.help.help')],
  ]
  const button = (action: keyof typeof ICONS, label: string, pressed?: boolean) =>
    `<button type="button" data-act="${action}" aria-label="${e(label)}"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}>${ICONS[action]}</button>`

  return (
    `<!doctype html><html lang="${options.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">` +
    `<title>${e(options.title)} · ${e(t('export.slides.document'))}</title><style>${SLIDES_CSS}</style></head><body>` +
    `<noscript><p class="noscript">${e(t('export.slides.noscript'))} <a href="${e(page.links.page)}">${e(t('export.slides.outro.page'))}</a></p></noscript>` +
    `<div class="viewport"><main class="stage" data-stage tabindex="-1">${specs.map((spec, index) => section(spec, bases[index]!)).join('')}</main></div>` +
    `<div class="hud" data-hud>${button('previous', t('export.slides.hud.previous'))}<span class="counter" data-counter></span>${button('next', t('export.slides.hud.next'))}` +
    `${button('overview', t('export.slides.hud.overview'))}${button('band', t('export.slides.hud.band'), true)}${button('autoplay', t('export.slides.hud.autoplay'), false)}` +
    `${button('clean', t('export.slides.hud.clean'), false)}${button('fullscreen', t('export.slides.hud.fullscreen'))}${button('help', t('export.slides.hud.help'))}` +
    // Live, the slideshow runs in the window Present opened: closing it returns to the app as it was.
    `<a href="${e(page.links.exit)}" data-exit${page.live ? ' data-close' : ''} aria-label="${e(t('export.slides.hud.exit'))}">${ICONS.close}</a></div>` +
    `<div class="overlay" data-overview hidden><h2>${e(t('export.slides.hud.overview'))}</h2><div class="ov-grid" data-grid></div></div>` +
    `<div class="overlay" data-help hidden><h2>${e(t('export.slides.hud.help'))}</h2><dl class="keys">${help.map(([keys, text]) => `<dt><kbd>${e(keys)}</kbd></dt><dd>${e(text)}</dd>`).join('')}</dl></div>` +
    `<div class="blackout" data-black hidden></div><p class="focus-hint" data-focus-hint hidden>${e(t('export.slides.focusHint'))}</p>` +
    `<script type="application/json" id="slides-data">${jsonBlock(data)}</script><script>${SLIDES_SCRIPT}</script></body></html>`
  )
}
