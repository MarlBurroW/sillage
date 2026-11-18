import { createHash } from 'node:crypto'
import {
  agentMarkSvg,
  deliverableKind,
  niceCeiling,
  runTotalTokens,
  variantAgent,
  type BenchmarkComparison,
  type BenchmarkDto,
  type BenchmarkExportBlocker,
  type BenchmarkExportMode,
  type BenchmarkRunDto,
  type BenchmarkShareOptions,
  type BenchmarkVariantDto,
} from '@sillage/protocol'
import { exportText } from '../exports/labels.js'
import { agents, escapeHtml } from '../exports/render.js'
import type { RunFile } from './exportability.js'
import {
  FRAME_SANDBOX,
  encodePath,
  fill,
  formatters,
  jsonBlock,
  letterOf,
  messageRenderer,
  shareMeasures,
  type ShareMeasure,
  type ShareMeasureKey,
  type ShareMeasureValue,
} from './share-parts.js'

/**
 * The page a shared benchmark is read on: the prompt, what each variant produced running live
 * side by side, the measurements as a chart and a table, a head-to-head the reader composes, the
 * final messages. One self-contained document with relative links to the copied productions, so
 * the same bytes work behind a public link and unzipped on a disk.
 */

export interface SharePageRun {
  run: BenchmarkRunDto
  mode: BenchmarkExportMode
  reason: BenchmarkExportBlocker | null
  /** Folder of the copied files, relative to the page; null when nothing is embedded. */
  dir: string | null
  entry: string | null
  files: RunFile[]
  /** Beginning of each text file shown in `files` mode: a page opened from disk cannot fetch them. */
  excerpts: Record<string, string>
}

export interface SharePage {
  benchmark: BenchmarkDto
  options: BenchmarkShareOptions
  runs: SharePageRun[]
  /** Variant ids in display order; shuffled by the caller for a blind page. */
  order: string[]
  sharedAt: number
  /**
   * Rendered for the owner over the run folders (`dir` points at preview URLs) rather than as a
   * frozen copy. A live document never links to a preview URL: a hovered link shows its address
   * in the status bubble, which a screen recording would capture.
   */
  live: boolean
  /**
   * Where the two documents point at each other: relative file names in a snapshot or archive,
   * live routes for the owner. `slides` is null when the publication has no slideshow; `exit` is
   * where the slideshow's close control leads.
   */
  links: { page: string; slides: string | null; exit: string }
  /** Saved comparisons the publication features, every contestant shown (see featuredComparisons). */
  comparisons: BenchmarkComparison[]
}

const logo = '<svg viewBox="0 0 100 100" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79ZM23 79C47 79 39 21 65 21H78C54 21 62 79 36 79ZM42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z"/></svg>'

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
const ICONS = {
  reload: icon('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  open: icon('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  expand: icon('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>'),
  play: icon('<path d="M7 4v16l13-8z"/>'),
}

// Same palette as the shared conversation page: both are Sillage's public face.
const css = `
:root{color-scheme:light dark;--bg:#faf7fb;--surface:#fff;--sunken:#f1eaf3;--ink:#211925;--muted:#6d6172;--line:#e5dce8;--accent:#85409b;--on-accent:#fff;--code:#f0e9f2;--good:#2f7d4f;--bad:#b3403a}
@media(prefers-color-scheme:dark){:root{--bg:#0f0b11;--surface:#1e1820;--sunken:#171218;--ink:#eee8f0;--muted:#b5aab9;--line:#322936;--accent:#cd7be5;--on-accent:#1b1120;--code:#261f28;--good:#6fcf97;--bad:#f0837c}}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
body.locked{overflow:hidden}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.column{max-width:1180px;margin:0 auto;padding:0 clamp(1.25rem,4vw,2.5rem)}
.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:2rem;font-size:.85rem;color:var(--muted)}
.top-end{display:flex;flex-wrap:wrap;align-items:center;justify-content:end;gap:.6rem 1rem}
.brand{display:inline-flex;flex:none;align-items:center;gap:.5rem;font-weight:650;font-size:1rem;color:var(--ink);letter-spacing:-.03em;white-space:nowrap}
.intro{padding:clamp(2.5rem,7vw,5rem) 0 clamp(2rem,5vw,3.5rem)}
.kicker{margin:0 0 .9rem;font-size:.9rem;color:var(--muted)}
h1{margin:0;font-size:clamp(2.2rem,5.6vw,4.2rem);line-height:1.06;letter-spacing:-.05em;font-weight:650;max-width:20ch;text-wrap:balance}
.lead{margin:1.4rem 0 0;font-size:1.15rem;color:var(--muted);max-width:60ch}
.note{margin:1rem 0 0;max-width:65ch;white-space:pre-wrap}
.brief{margin-top:2.5rem;background:var(--surface);border-left:3px solid var(--accent);padding:1.1rem 1.4rem 1.2rem;max-width:78ch}
.brief h2{margin:0 0 .5rem;font-size:.85rem;font-weight:650;color:var(--muted)}
.prompt-text{margin:0;white-space:pre-wrap;font-size:1.02rem;line-height:1.7}
.js .prompt-text:not(.open){max-height:13.6em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent);mask-image:linear-gradient(#000 70%,transparent)}
.link{border:0;background:none;padding:0;margin-top:.7rem;font:inherit;font-size:.9rem;color:var(--accent);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
h2.section{margin:0;font-size:clamp(1.4rem,2.6vw,1.9rem);letter-spacing:-.03em;font-weight:650;line-height:1.2}
.stage-head{display:flex;flex-wrap:wrap;align-items:end;justify-content:space-between;gap:1rem 2rem;padding-bottom:1.1rem}
.stage-head p{margin:.35rem 0 0;font-size:.9rem;color:var(--muted);max-width:60ch}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem}
.seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:2px}
.seg button{border:0;background:none;color:var(--muted);font:inherit;font-size:.85rem;padding:.3rem .7rem;border-radius:6px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}
.pill,select.pill{border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;font-size:.85rem;padding:.38rem .75rem;cursor:pointer}
.pill[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
a.pill{display:inline-flex;align-items:center;gap:.45rem;text-decoration:none;font-weight:600}
.bleed{padding:0 clamp(.75rem,2vw,2rem)}
.tabs{display:flex;gap:.4rem;overflow-x:auto;padding-bottom:.8rem}
.tabs button{display:inline-flex;align-items:center;gap:.5rem;flex:none;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--muted);font:inherit;font-size:.88rem;padding:.3rem .8rem .3rem .3rem;cursor:pointer}
.tabs button[aria-selected=true]{border-color:var(--accent);color:var(--ink)}
.letter{display:inline-grid;place-items:center;flex:none;width:1.7rem;height:1.7rem;border-radius:5px;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:.9rem;line-height:1}
.mark{display:inline-flex;flex:none;color:var(--ink)}
.lineup{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .6rem;padding:0 0 1rem}
.lineup-label{font-size:.85rem;font-weight:600;color:var(--muted);margin-right:.2rem}
.chip{display:inline-flex;align-items:center;gap:.45rem;max-width:19rem;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);font:inherit;font-size:.85rem;padding:.2rem .8rem .2rem .25rem;cursor:pointer}
.chip .letter{width:1.45rem;height:1.45rem;border-radius:999px;font-size:.78rem}
.chip .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip[aria-pressed=true]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.featured{display:inline-flex;flex-wrap:wrap;gap:.4rem}
.lineup-hint{flex-basis:100%;margin:0;font-size:.82rem;color:var(--muted)}
.h2h{margin:0 0 1.4rem;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:1rem 1.1rem 1.1rem}
.h2h h3{margin:0 0 .4rem;font-size:1.15rem;letter-spacing:-.02em}
.h2h th{font-size:.82rem;font-weight:600;color:var(--muted);white-space:nowrap}
.h2h thead th{color:var(--ink)}
.h2h td{font-variant-numeric:tabular-nums;white-space:nowrap;vertical-align:top}
.h2h td.win{color:var(--accent);font-weight:650}
.h2h td small{display:block;font-size:.76rem;font-weight:400;color:var(--muted)}
.h2h tr.wins td,.h2h tr.wins th{font-weight:650;border-bottom:0}
.h2h p{margin:.6rem 0 0;font-size:.82rem;color:var(--muted)}
.dim{opacity:.32}
.stage{display:grid;gap:1rem;grid-template-columns:minmax(0,1fr)}
.js .stage[data-layout=side]{grid-auto-flow:column;grid-template-columns:none;grid-auto-columns:minmax(min(86vw,26rem),1fr);overflow-x:auto;scroll-snap-type:x proximity;padding-bottom:.6rem}
.lane{display:flex;flex-direction:column;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden;scroll-snap-align:start}
.lane-bar{display:flex;align-items:center;gap:.7rem;padding:.55rem .6rem .55rem .7rem;border-bottom:1px solid var(--line)}
.who{min-width:0;flex:1;line-height:1.25}.who strong{display:block;font-size:.95rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.who span{display:block;font-size:.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flag{flex:none;font-size:.75rem;font-weight:600;color:var(--bad);border:1px solid currentColor;border-radius:5px;padding:0 .4rem}
.acts{display:flex;gap:.15rem;flex:none}
.acts a,.acts button{display:grid;place-items:center;width:2rem;height:2rem;border:0;border-radius:6px;background:none;color:var(--muted);cursor:pointer}
.acts a:hover,.acts button:hover{background:var(--sunken);color:var(--ink)}
.lane-body{height:min(74vh,820px);background:var(--sunken);display:flex;justify-content:center;min-height:0}
.lane-body iframe{width:100%;height:100%;border:0;background:#fff}
.stage[data-width=phone] .lane-body iframe{max-width:390px;border-inline:1px solid var(--line)}
.lane-body.read{display:block;overflow:auto;padding:1.2rem 1.3rem;background:var(--surface)}
.lane-stats{display:flex;flex-wrap:wrap;gap:.2rem 1.4rem;margin:0;padding:.55rem .8rem;border-top:1px solid var(--line);font-size:.82rem}
.lane-stats div{display:flex;gap:.4rem}.lane-stats dt{color:var(--muted)}.lane-stats dd{margin:0;font-variant-numeric:tabular-nums;font-weight:600}
.lane.max{position:fixed;inset:0;z-index:20;border-radius:0;border:0}.lane.max .lane-body{flex:1;height:auto}
.blocked{margin:0 0 1.2rem;padding:.8rem 1rem;border:1px dashed var(--line);border-radius:8px;color:var(--muted);font-size:.9rem}
.gallery figure{margin:0 0 1.4rem}.gallery img,.gallery video{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:6px}.gallery audio{width:100%}
.gallery figcaption{font-size:.8rem;color:var(--muted);padding:.4rem 0 0;display:flex;gap:.8rem;justify-content:space-between}
.prose>:first-child{margin-top:0}.prose>:last-child{margin-bottom:0}.prose h1{font-size:1.4rem;letter-spacing:-.02em;line-height:1.3;max-width:none}.prose h2{font-size:1.2rem}.prose h3{font-size:1.05rem}
.prose p{margin:0 0 1em}.prose ul,.prose ol{padding-left:1.4em}.prose li{margin:.25em 0}.prose blockquote{margin:1rem 0;padding:.1rem 1rem;border-left:2px solid var(--line);color:var(--muted)}
pre{background:var(--code);padding:.9rem 1.1rem;overflow:auto;border-radius:6px;font-size:.8rem;line-height:1.6;tab-size:2}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}p code,li code{font-size:.86em;background:var(--code);padding:.1em .3em;border-radius:3px}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;min-width:100%;font-size:.9rem}th,td{text-align:left;padding:.6rem .8rem;border-bottom:1px solid var(--line)}
.numbers{padding-top:clamp(3rem,7vw,5rem)}.numbers .table-wrap{margin-top:1.4rem}
.numbers th{font-size:.82rem;font-weight:600;color:var(--muted);white-space:nowrap}.numbers td{font-variant-numeric:tabular-nums;white-space:nowrap;vertical-align:top}
.numbers td.name{white-space:normal;min-width:12rem}.name-row{display:flex;align-items:center;gap:.7rem}.name-row strong{font-weight:650}.name-row small{display:block;color:var(--muted);font-size:.78rem}
.bar{display:block;height:4px;margin-top:.4rem;background:var(--sunken);min-width:5rem}.bar i{display:block;height:100%;background:var(--muted);opacity:.55}
td.best{color:var(--accent);font-weight:650}td.best .bar i{background:var(--accent);opacity:1}
td small.weak{display:block;font-size:.74rem;font-weight:400;color:var(--muted)}
.pass{color:var(--good)}.fail{color:var(--bad)}
.foot{font-size:.82rem;color:var(--muted);margin:.9rem 0 0;max-width:70ch}
.charts{margin-top:1.6rem}
.chart-switch{margin-bottom:1.2rem}
.chart{margin:0 0 2.4rem}
.chart figcaption{display:flex;flex-wrap:wrap;align-items:baseline;gap:.2rem 1rem;margin-bottom:.9rem}
.chart figcaption strong{font-size:1.1rem;letter-spacing:-.02em}
.chart figcaption span{font-size:.82rem;color:var(--muted)}
.crow{display:grid;grid-template-columns:minmax(7rem,15rem) minmax(0,1fr);align-items:center;gap:.9rem;padding:.2rem 0}
.cname{display:flex;align-items:center;gap:.5rem;min-width:0;font-size:.9rem}
.cname .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ctrack{position:relative;height:1.9rem;margin-right:5.5rem}
.tick{position:absolute;top:0;bottom:0;width:1px;background:var(--line)}
.cbar{position:absolute;left:0;top:50%;height:.95rem;min-width:2px;transform:translateY(-50%);border-radius:0 3px 3px 0;background:var(--muted);opacity:.5}
.crow.best .cbar{background:var(--accent);opacity:1}
.cdot{position:absolute;top:50%;width:.6rem;height:.6rem;border-radius:50%;background:var(--ink);box-shadow:0 0 0 2px var(--bg);transform:translate(-50%,-50%)}
.cval{position:absolute;top:50%;transform:translateY(-50%);padding-left:.5rem;font-size:.82rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.crow.best .cval{color:var(--accent);font-weight:650}
.cval small{font-size:.74rem;color:var(--muted);font-weight:400}
.caxis .ctrack{height:1.1rem}
.caxis .ctrack>span{position:absolute;top:0;font-size:.72rem;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.js .charts[data-switch] .chart:not(.on){display:none}
.said{padding-top:clamp(3rem,7vw,5rem)}.said details{border-bottom:1px solid var(--line)}.said details:first-of-type{margin-top:1.2rem;border-top:1px solid var(--line)}
.said summary{display:flex;align-items:center;gap:.7rem;padding:.8rem 0;cursor:pointer;font-weight:650;list-style:none}.said summary::-webkit-details-marker{display:none}
.said summary:after{content:"+";margin-left:auto;color:var(--muted);font-weight:400;font-size:1.2rem}.said details[open] summary:after{content:"–"}
.said .prose{padding:.2rem 0 1.6rem;max-width:78ch}
footer.column{margin-top:clamp(3.5rem,8vw,6rem);border-top:1px solid var(--line);padding-top:2rem;padding-bottom:3rem;font-size:.85rem;color:var(--muted)}footer p{margin:.5rem 0 .9rem}footer a{font-weight:600}
@media(max-width:820px){.lane-body{height:72vh}.stage-head{align-items:start}}
@media(max-width:600px){.crow{grid-template-columns:minmax(4.5rem,7.5rem) minmax(0,1fr);gap:.6rem}.ctrack{margin-right:4.6rem}.caxis .ctrack>span:nth-child(2){display:none}.top{align-items:start}}
@media print{.controls,.tabs,.acts,.lineup,.chart-switch,.top-end a.pill{display:none}.lane-body{height:60vh}.js .charts[data-switch] .chart{display:block!important}.dim{opacity:1}}
`

/**
 * Behaviour of the page. Constant so its hash can be pinned in the policy: every word it writes
 * comes from a `data-` attribute or from the page's JSON block, and it builds nodes with
 * `textContent` only. Without it the page still reads top to bottom: lanes stacked, every chart
 * shown. Kept free of backquotes because it lives in a template literal.
 */
const script = String.raw`(function () {
  'use strict'
  var d = document
  function q(selector, root) { return Array.prototype.slice.call((root || d).querySelectorAll(selector)) }
  d.documentElement.classList.add('js')

  var data = null
  var dataNode = d.getElementById('bench-data')
  try { data = dataNode ? JSON.parse(dataNode.textContent || 'null') : null } catch (error) { data = null }
  var revealed = false
  var number = new Intl.NumberFormat(d.documentElement.lang || 'en', { maximumFractionDigits: 1 })

  // A short prompt opens in full; a long one keeps a button for the rest.
  var prompt = d.querySelector('[data-prompt]')
  var more = d.querySelector('[data-prompt-more]')
  if (prompt) {
    if (more && prompt.scrollHeight > prompt.clientHeight + 8) {
      more.hidden = false
      more.addEventListener('click', function () { prompt.classList.add('open'); more.hidden = true })
    } else prompt.classList.add('open')
  }

  function nameOf(index) {
    var name = data && data.names[index]
    if (!name) return ''
    return data.blind && !revealed ? name.blind : name.real
  }

  // Blind pages swap every name at once, including the head-to-head drawn below.
  var reveal = d.querySelector('[data-reveal]')
  if (reveal) {
    reveal.addEventListener('click', function () {
      revealed = !revealed
      q('[data-real]').forEach(function (node) { node.textContent = revealed ? node.dataset.real : node.dataset.blind })
      reveal.textContent = revealed ? reveal.dataset.hide : reveal.dataset.show
      reveal.setAttribute('aria-pressed', String(revealed))
      drawHeadToHead()
    })
  }

  // One chart at a time once the script runs.
  var charts = d.querySelector('[data-charts]')
  var chartButtons = q('[data-chart-btn]')
  function showChart(key) {
    q('[data-chart]').forEach(function (figure) { figure.classList.toggle('on', figure.dataset.chart === key) })
    chartButtons.forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.chartBtn === key)) })
  }
  if (charts && chartButtons.length) {
    charts.setAttribute('data-switch', '')
    chartButtons.forEach(function (button) { button.addEventListener('click', function () { showChart(button.dataset.chartBtn) }) })
    showChart(chartButtons[0].dataset.chartBtn)
  }

  // Comparison: two to four variants, kept in the address as letters so a link can carry one.
  var MAX = 4
  var selection = []
  var hint = d.querySelector('[data-lineup-hint]')
  function selected(index) { return selection.length < 2 || selection.indexOf(index) >= 0 }
  function readHash() {
    if (!data) return []
    var match = /(?:^|[#&])vs=([A-Za-z0-9,]+)/.exec(location.hash)
    if (!match) return []
    var picked = []
    match[1].split(',').forEach(function (letter) {
      var index = data.letters.indexOf(letter.toUpperCase())
      if (index >= 0 && picked.indexOf(index) < 0 && picked.length < MAX) picked.push(index)
    })
    return picked
  }
  function writeHash() {
    var letters = selection.map(function (index) { return data.letters[index] })
    var url = location.pathname + location.search + (letters.length ? '#vs=' + letters.join(',') : '')
    try { history.replaceState(null, '', url) } catch (error) { /* A page opened from disk may refuse; the selection still applies. */ }
  }
  function featuredTitle() {
    // An author's title may name the models: a blind page keeps it until the reveal.
    if (data.blind && !revealed) return null
    var key = selection.slice().sort().join(',')
    for (var i = 0; i < data.featured.length; i++) {
      if (data.featured[i].indices.slice().sort().join(',') === key) return data.featured[i].title
    }
    return null
  }
  function node(tag, text, className) {
    var element = d.createElement(tag)
    if (className) element.className = className
    if (text) element.textContent = text
    return element
  }
  function distance(key, value, best) {
    var sign = value - best > 0 ? '+' : '−'
    if (key === 'rating') return sign + number.format(Math.abs(value - best))
    if (key === 'passRate') return data.labels.points.replace('{value}', sign + number.format(Math.abs(value - best) * 100))
    if (value <= 0 || best <= 0) return null
    return data.labels.factor.replace('{factor}', number.format(Math.max(value, best) / Math.min(value, best)))
  }
  function drawHeadToHead() {
    var box = d.querySelector('[data-h2h]')
    if (!box || !data) return
    box.textContent = ''
    if (selection.length < 2) { box.hidden = true; return }
    box.hidden = false
    box.appendChild(node('h3', featuredTitle() || selection.map(nameOf).join(data.labels.vs)))
    if (!data.measures.length) return
    var table = node('table')
    var head = node('tr')
    head.appendChild(node('th', data.labels.measure))
    selection.forEach(function (index) {
      var cell = node('th')
      cell.appendChild(node('span', data.letters[index], 'letter'))
      cell.appendChild(d.createTextNode(' ' + nameOf(index)))
      head.appendChild(cell)
    })
    var thead = node('thead')
    thead.appendChild(head)
    table.appendChild(thead)
    var body = node('tbody')
    var wins = selection.map(function () { return 0 })
    var single = false
    var factors = false
    data.measures.forEach(function (measure) {
      var row = node('tr')
      row.appendChild(node('th', measure.label))
      var values = selection.map(function (index) { return measure.values[index] })
      var competing = values.filter(function (value) { return value && value.eligible && value.median !== null })
      var best = null
      if (measure.direction && competing.length >= 2) {
        best = competing[0].median
        competing.forEach(function (value) { best = measure.direction === 'lower' ? Math.min(best, value.median) : Math.max(best, value.median) })
      }
      var holders = best === null ? 0 : competing.filter(function (value) { return value.median === best }).length
      values.forEach(function (value, position) {
        if (!value || value.median === null) { row.appendChild(node('td', '–')); return }
        if (measure.key !== 'passRate' && value.count < 2) single = true
        var cell = node('td', value.text)
        var note = null
        if (!value.eligible) note = data.labels.failedOnly
        else if (best !== null && value.median === best) {
          if (holders === 1) {
            cell.className = 'win'
            cell.textContent = '▲ ' + value.text
            wins[position] += 1
            note = data.labels.best
          } else note = data.labels.tie
        } else if (best !== null) {
          note = distance(measure.key, value.median, best)
          if (note && measure.key !== 'rating' && measure.key !== 'passRate') factors = true
        }
        if (note) cell.appendChild(node('small', note))
        row.appendChild(cell)
      })
      body.appendChild(row)
    })
    var tally = node('tr', '', 'wins')
    tally.appendChild(node('th', data.labels.wins))
    wins.forEach(function (count) { tally.appendChild(node('td', String(count))) })
    body.appendChild(tally)
    table.appendChild(body)
    var wrap = node('div', '', 'table-wrap')
    wrap.appendChild(table)
    box.appendChild(wrap)
    if (factors) box.appendChild(node('p', data.labels.factorNote))
    if (single) box.appendChild(node('p', data.labels.single))
  }

  // Productions: side by side or one at a time, one repetition at a time.
  var stage = d.querySelector('[data-stage]')
  var lanes = stage ? q('[data-lane]', stage) : []
  var tabs = q('[data-tab]')
  var tablist = d.querySelector('[data-tabs]')
  var repetitions = d.querySelector('[data-rep-select]')
  var state = { layout: 'side', rep: lanes.length ? lanes[0].dataset.rep : '1', active: lanes.length ? lanes[0].dataset.variant : '0', width: 'full' }
  if (matchMedia('(max-width:820px)').matches || tabs.length > 4) state.layout = 'one'
  function applyStage() {
    if (!stage) return
    // In one-at-a-time mode the lane shown must be one of the compared variants.
    if (selection.length >= 2 && selection.indexOf(Number(state.active)) < 0) state.active = String(selection[0])
    stage.dataset.layout = state.layout
    stage.dataset.width = state.width
    lanes.forEach(function (lane) {
      lane.hidden = lane.dataset.rep !== state.rep || (state.layout === 'one' && lane.dataset.variant !== state.active) || !selected(Number(lane.dataset.variant))
    })
    q('[data-rep-item]').forEach(function (item) { item.hidden = item.dataset.rep !== state.rep })
    q('[data-layout-btn]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.layoutBtn === state.layout)) })
    q('[data-width-btn]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.widthBtn === state.width)) })
    if (tablist) tablist.hidden = state.layout !== 'one'
    tabs.forEach(function (tab) {
      var on = tab.dataset.tab === state.active
      tab.hidden = !selected(Number(tab.dataset.tab))
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
    })
  }
  q('[data-layout-btn]').forEach(function (button) { button.addEventListener('click', function () { state.layout = button.dataset.layoutBtn; applyStage() }) })
  q('[data-width-btn]').forEach(function (button) { button.addEventListener('click', function () { state.width = button.dataset.widthBtn; applyStage() }) })
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () { state.active = tab.dataset.tab; applyStage() })
    tab.addEventListener('keydown', function (event) {
      var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (!step) return
      event.preventDefault()
      var visible = tabs.filter(function (candidate) { return !candidate.hidden })
      var next = visible[(visible.indexOf(tab) + step + visible.length) % visible.length]
      state.active = next.dataset.tab
      applyStage()
      next.focus()
    })
  })
  if (repetitions) repetitions.addEventListener('change', function () { state.rep = repetitions.value; applyStage() })
  function close() {
    q('.lane.max').forEach(function (lane) {
      lane.classList.remove('max')
      var button = lane.querySelector('[data-expand]')
      if (button) { button.setAttribute('aria-label', button.dataset.expand); button.title = button.dataset.expand }
    })
    d.body.classList.remove('locked')
  }
  q('[data-expand]').forEach(function (button) {
    button.addEventListener('click', function () {
      var lane = button.closest('[data-lane]')
      if (lane.classList.contains('max')) { close(); return }
      close()
      lane.classList.add('max')
      d.body.classList.add('locked')
      button.setAttribute('aria-label', button.dataset.collapse)
      button.title = button.dataset.collapse
    })
  })
  q('[data-reload]').forEach(function (button) {
    button.addEventListener('click', function () {
      var frame = button.closest('[data-lane]').querySelector('iframe')
      if (frame) frame.src = frame.getAttribute('src')
    })
  })
  d.addEventListener('keydown', function (event) { if (event.key === 'Escape') close() })

  function applySelection() {
    q('[data-pick]').forEach(function (chip) { chip.setAttribute('aria-pressed', String(selection.indexOf(Number(chip.dataset.pick)) >= 0)) })
    q('[data-index]').forEach(function (item) { item.classList.toggle('dim', !selected(Number(item.dataset.index))) })
    var clear = d.querySelector('[data-pick-clear]')
    if (clear) clear.hidden = selection.length === 0
    if (hint) { hint.textContent = hint.dataset.idle; hint.hidden = selection.length >= 2 }
    drawHeadToHead()
    applyStage()
  }
  q('[data-pick]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var index = Number(chip.dataset.pick)
      var at = selection.indexOf(index)
      if (at >= 0) selection.splice(at, 1)
      else if (selection.length < MAX) selection.push(index)
      else {
        if (hint) { hint.textContent = hint.dataset.full; hint.hidden = false }
        return
      }
      writeHash()
      applySelection()
    })
  })
  q('[data-featured]').forEach(function (button) {
    button.addEventListener('click', function () {
      var entry = data && data.featured[Number(button.dataset.featured)]
      if (!entry) return
      selection = entry.indices.slice(0, MAX)
      writeHash()
      applySelection()
    })
  })
  var clearButton = d.querySelector('[data-pick-clear]')
  if (clearButton) clearButton.addEventListener('click', function () { selection = []; writeHash(); applySelection() })

  // A link edited by hand, or the back button, changes the hash without reloading the page.
  window.addEventListener('hashchange', function () { selection = readHash(); applySelection() })

  q('[data-controls]').forEach(function (controls) { controls.hidden = false })
  selection = readHash()
  applySelection()
})()`

/**
 * Hashes of the scripts already published pages carry, oldest last. A snapshot keeps the script
 * it was written with while the page policy is built from today's code: without these, every
 * page published before a script change would lose its controls and its reveal button. Append
 * the current hash here before changing `script`, never remove one.
 */
export const LEGACY_PAGE_SCRIPT_HASHES = ['CP+VGVFiB9dLlby8z5RBGKsjF58PlNb92zIBfJP9XeY=']

/** Today's script first, then every published one. */
export const PAGE_SCRIPT_HASHES = [createHash('sha256').update(script).digest('base64'), ...LEGACY_PAGE_SCRIPT_HASHES]

const TERMINAL_FAILURES = new Set(['failed', 'timed_out', 'cancelled'])

type ExportKey = Parameters<ReturnType<typeof exportText>>[0]

const MEASURE_LABELS: Record<ShareMeasureKey, ExportKey> = {
  durationMs: 'export.bench.col.duration',
  tokens: 'export.bench.col.tokens',
  costUsd: 'export.bench.col.cost',
  toolCalls: 'export.bench.col.tools',
  passRate: 'export.bench.col.check',
  rating: 'export.bench.col.rating',
}

export function renderBenchmarkShare(page: SharePage): string {
  const { benchmark, options } = page
  const t = exportText(options.locale)
  const e = escapeHtml
  const format = formatters(options.locale)
  const percent = new Intl.NumberFormat(options.locale, { style: 'percent', maximumFractionDigits: 0 })
  const md = messageRenderer()

  const variants = page.order
    .map((id) => benchmark.variants.find((variant) => variant.id === id))
    .filter((variant): variant is BenchmarkVariantDto => !!variant)
  const blindName = (index: number) => fill(t('export.bench.variant'), { letter: letterOf(index) })
  // Before the display names existed, a DTO carried only `label`.
  const technical = (variant: BenchmarkVariantDto) => variant.technicalLabel || variant.label

  /** Text that a blind page hides until revealed. The real value stays in the markup: this is a game, not a secret. */
  const named = (tag: string, real: string, blind: string, attrs = '') =>
    options.blind
      ? `<${tag}${attrs} data-real="${e(real)}" data-blind="${e(blind)}">${e(blind)}</${tag}>`
      : `<${tag}${attrs}>${e(real)}</${tag}>`
  const variantName = (index: number, tag = 'strong', attrs = '') => named(tag, variants[index]!.label, blindName(index), attrs)
  /** CLI and exact model under the name: what a reader checks once the game is over. */
  const detailLine = (index: number, tag = 'span') => {
    const variant = variants[index]!
    const technicalLabel = technical(variant)
    const real = technicalLabel === variant.label ? agents[variantAgent(variant)] : `${agents[variantAgent(variant)]} · ${technicalLabel}`
    return named(tag, real, ' ')
  }
  // Marks cannot be swapped like text, so a blind page carries none.
  const mark = (index: number, size: number) => (options.blind ? '' : `<span class="mark">${agentMarkSvg(variantAgent(variants[index]!), size)}</span>`)

  const repetitions = [...new Set(page.runs.map((item) => item.run.repetition))].sort((a, b) => a - b)
  const runOf = (variant: BenchmarkVariantDto, repetition: number) =>
    page.runs.find((item) => item.run.variantId === variant.id && item.run.repetition === repetition)

  const blockedNotice = (item: SharePageRun) =>
    item.reason && !(item.reason === 'empty' && item.run.response)
      ? `<p class="blocked">${e(t(`export.bench.blocked.${item.reason}`))}</p>`
      : ''

  const response = (item: SharePageRun) =>
    item.run.response
      ? `<div class="prose">${md.render(item.run.response)}</div>`
      : `<p class="blocked">${e(t('export.bench.noResponse'))}</p>`

  const gallery = (item: SharePageRun) => {
    const parts = item.files.map((file) => {
      const url = `${item.dir}/${encodePath(file.path)}`
      // A live page links to no preview URL: its address would show in a recording.
      const download = page.live ? '' : `<a href="${e(url)}" download>${e(t('export.bench.download'))}</a>`
      const caption = `<figcaption><span>${e(file.path)}</span>${download}</figcaption>`
      switch (deliverableKind(file.path)) {
        case 'image':
          return `<figure><img src="${e(url)}" alt="${e(file.path)}" loading="lazy">${caption}</figure>`
        case 'video':
          return `<figure><video src="${e(url)}" controls preload="metadata"></video>${caption}</figure>`
        case 'audio':
          return `<figure><audio src="${e(url)}" controls preload="metadata"></audio>${caption}</figure>`
        case 'text': {
          const excerpt = item.excerpts[file.path]
          return excerpt === undefined ? `<figure>${caption}</figure>` : `<figure><pre><code>${e(excerpt)}</code></pre>${caption}</figure>`
        }
        default:
          return `<figure>${caption}</figure>`
      }
    })
    return `<div class="gallery">${parts.join('')}</div>`
  }

  const stat = (label: string, value: string | null) => (value === null ? '' : `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`)

  const lane = (item: SharePageRun, index: number) => {
    const { run } = item
    const metrics = run.metrics
    const tokens = runTotalTokens(run)
    let body: string
    let actions = ''
    if (item.mode === 'page' && item.dir && item.entry) {
      const url = `${item.dir}/${encodePath(item.entry)}`
      // The title names the variant as the reader sees it; a blind page must not leak it to a tooltip.
      body = `<div class="lane-body"><iframe src="${e(url)}" sandbox="${FRAME_SANDBOX}" loading="lazy" title="${e(blindName(index))}"></iframe></div>`
      actions = `<button type="button" data-reload aria-label="${e(t('export.bench.reload'))}" title="${e(t('export.bench.reload'))}">${ICONS.reload}</button>`
      if (!page.live) {
        actions += `<a href="${e(url)}" target="_blank" rel="noopener noreferrer" aria-label="${e(t('export.bench.open'))}" title="${e(t('export.bench.open'))}">${ICONS.open}</a>`
      }
    } else if (item.mode === 'files' && item.dir) {
      body = `<div class="lane-body read">${gallery(item)}</div>`
    } else {
      body = `<div class="lane-body read">${blockedNotice(item)}${options.includeResponses ? response(item) : ''}</div>`
    }
    const failure = TERMINAL_FAILURES.has(run.status) ? `<span class="flag">${e(t(`export.bench.status.${run.status as 'failed' | 'timed_out' | 'cancelled'}`))}</span>` : ''
    const stats = options.includeMetrics
      ? `<dl class="lane-stats">${stat(t('export.bench.col.duration'), metrics?.durationMs != null ? format.duration(metrics.durationMs) : null)}${stat(t('export.bench.col.tokens'), tokens === null ? null : format.tokens(tokens))}${stat(t('export.bench.col.cost'), metrics?.costUsd != null ? format.cost(metrics.costUsd) : null)}${stat(t('export.bench.col.tools'), metrics ? format.number(metrics.toolCalls) : null)}</dl>`
      : ''
    return (
      `<article class="lane" data-lane data-rep="${run.repetition}" data-variant="${index}">` +
      `<header class="lane-bar"><span class="letter">${letterOf(index)}</span>${mark(index, 18)}<div class="who">${variantName(index)}${detailLine(index)}</div>${failure}` +
      `<div class="acts">${actions}<button type="button" data-expand="${e(t('export.bench.expand'))}" data-collapse="${e(t('export.bench.collapse'))}" aria-label="${e(t('export.bench.expand'))}" title="${e(t('export.bench.expand'))}">${ICONS.expand}</button></div></header>` +
      body + stats + '</article>'
    )
  }

  const lanes: string[] = []
  for (const repetition of repetitions) {
    variants.forEach((variant, index) => {
      const item = runOf(variant, repetition)
      if (item) lanes.push(lane(item, index))
    })
  }

  const tabs = variants
    .map((_, index) => `<button type="button" role="tab" data-tab="${index}"><span class="letter">${letterOf(index)}</span>${variantName(index, 'span')}</button>`)
    .join('')

  const hasPage = page.runs.some((item) => item.mode === 'page')
  const controls =
    `<div class="controls" data-controls hidden>` +
    (options.blind
      ? `<button type="button" class="pill" data-reveal aria-pressed="false" data-show="${e(t('export.bench.reveal'))}" data-hide="${e(t('export.bench.hide'))}">${e(t('export.bench.reveal'))}</button>`
      : '') +
    (repetitions.length > 1
      ? `<select class="pill" data-rep-select aria-label="${e(t('export.bench.repetitionLabel'))}">${repetitions.map((n) => `<option value="${n}">${e(fill(t('export.bench.repetition'), { n }))}</option>`).join('')}</select>`
      : '') +
    (variants.length > 1
      ? `<div class="seg" role="group" aria-label="${e(t('export.bench.layout'))}"><button type="button" data-layout-btn="side">${e(t('export.bench.sideBySide'))}</button><button type="button" data-layout-btn="one">${e(t('export.bench.oneAtATime'))}</button></div>`
      : '') +
    (hasPage
      ? `<div class="seg" role="group" aria-label="${e(t('export.bench.width'))}"><button type="button" data-width-btn="full">${e(t('export.bench.widthFull'))}</button><button type="button" data-width-btn="phone">${e(t('export.bench.widthPhone'))}</button></div>`
      : '') +
    '</div>'

  // --- Measures -------------------------------------------------------------------

  const measures: ShareMeasure[] = options.includeMetrics ? shareMeasures(benchmark, page.order, page.runs.map((item) => item.run), options.includeRatings) : []
  const valueText = (key: ShareMeasureKey, value: number): string => {
    switch (key) {
      case 'durationMs': return format.duration(value)
      case 'tokens': return format.tokens(value)
      case 'costUsd': return format.cost(value)
      case 'toolCalls': return format.number(value)
      case 'passRate': return percent.format(value)
      case 'rating': return `${format.number(value)} / 5`
    }
  }
  const measureText = (measure: ShareMeasure, value: ShareMeasureValue): string | null => {
    if (value.median === null) return null
    if (measure.key === 'passRate') return fill(t('export.bench.checkPassed'), { passed: value.passed, total: value.checked })
    return valueText(measure.key, value.median)
  }
  const directionNote = (measure: ShareMeasure) =>
    measure.direction === 'lower' ? t('export.bench.lowerBetter') : measure.direction === 'higher' ? t('export.bench.higherBetter') : t('export.bench.noBetter')

  // --- Comparison -----------------------------------------------------------------

  // A title the author wrote may name the models ("Sonnet vs Terra"): a blind page shows letters until revealed.
  const comparisonTitle = (comparison: BenchmarkComparison) => {
    const indices = comparison.variantIds.map((id) => page.order.indexOf(id))
    const letters = indices.map((index) => letterOf(index)).join(t('export.bench.vs'))
    return named('span', comparison.title ?? indices.map((index) => variants[index]!.label).join(t('export.bench.vs')), letters)
  }
  const lineup = variants.length > 1
    ? `<div class="lineup" data-lineup data-controls hidden><span class="lineup-label">${e(t('export.bench.compare'))}</span>` +
      variants.map((_, index) => `<button type="button" class="chip" data-pick="${index}" aria-pressed="false"><span class="letter">${letterOf(index)}</span>${mark(index, 14)}${variantName(index, 'span', ' class="n"')}</button>`).join('') +
      (page.comparisons.length
        ? `<span class="featured">${page.comparisons.map((comparison, index) => `<button type="button" class="pill" data-featured="${index}">${comparisonTitle(comparison)}</button>`).join('')}</span>`
        : '') +
      `<button type="button" class="link" data-pick-clear hidden>${e(t('export.bench.compareClear'))}</button>` +
      `<p class="lineup-hint" data-lineup-hint data-idle="${e(t('export.bench.compareHint'))}" data-full="${e(t('export.bench.compareFull'))}">${e(t('export.bench.compareHint'))}</p></div>` +
      `<div class="h2h" data-h2h hidden aria-live="polite"></div>`
    : ''

  const data = {
    blind: options.blind,
    letters: variants.map((_, index) => letterOf(index)),
    names: variants.map((variant, index) => ({ real: variant.label, blind: blindName(index) })),
    measures: measures.map((measure) => ({
      key: measure.key,
      label: t(MEASURE_LABELS[measure.key]),
      direction: measure.direction,
      values: measure.values.map((value) => ({
        median: value.median,
        text: measureText(measure, value),
        eligible: value.eligible,
        count: measure.key === 'passRate' ? value.checked : value.values.length,
      })),
    })),
    featured: page.comparisons.map((comparison) => ({ title: comparison.title, indices: comparison.variantIds.map((id) => page.order.indexOf(id)) })),
    labels: {
      vs: t('export.bench.vs'),
      measure: t('export.bench.measure'),
      best: t('export.bench.best'),
      tie: t('export.bench.tie'),
      wins: t('export.bench.wins'),
      failedOnly: t('export.bench.failedOnly'),
      single: t('export.bench.singleRun'),
      factor: t('export.bench.factor'),
      factorNote: t('export.bench.factorNote'),
      points: t('export.bench.points'),
    },
  }

  // --- Numbers --------------------------------------------------------------------

  let numbers = ''
  if (measures.length > 0) {
    const tableCell = (measure: ShareMeasure, index: number) => {
      const value = measure.values[index]!
      const text = measureText(measure, value)
      if (text === null) return '<td>–</td>'
      const weak = value.eligible ? '' : `<small class="weak">${e(t('export.bench.failedOnly'))}</small>`
      if (measure.key === 'passRate') {
        return `<td class="${value.passed === value.checked ? 'pass' : 'fail'}">${e(text)}${weak}</td>`
      }
      const max = Math.max(0, ...measure.values.map((entry) => entry.median ?? 0))
      const width = max > 0 ? Math.max(2, Math.round((value.median! / max) * 100)) : 0
      return `<td${measure.best === index ? ' class="best"' : ''}>${e(text)}${weak}<span class="bar"><i style="width:${width}%"></i></span></td>`
    }
    const notes = [
      repetitions.length > 1 ? fill(t('export.bench.median'), { count: repetitions.length }) : '',
      t('export.bench.eligibleNote'),
      measures.some((measure) => measure.key === 'costUsd') ? t('export.bench.costNote') : '',
    ].filter(Boolean)
    const table =
      `<div class="table-wrap"><table><thead><tr><th>${e(t('export.bench.col.variant'))}</th>${measures.map((measure) => `<th>${e(t(MEASURE_LABELS[measure.key]))}</th>`).join('')}</tr></thead><tbody>` +
      variants.map((_, index) => `<tr data-index="${index}"><td class="name"><div class="name-row"><span class="letter">${letterOf(index)}</span>${mark(index, 16)}<div>${variantName(index)}${detailLine(index, 'small')}</div></div></td>${measures.map((measure) => tableCell(measure, index)).join('')}</tr>`).join('') +
      `</tbody></table></div>`
    const charts = options.includeChart ? renderCharts(measures) : ''
    numbers = `<section class="numbers column"><h2 class="section">${e(t('export.bench.numbers'))}</h2>${charts}${table}<p class="foot">${e(notes.join(' '))}</p></section>`
  }

  /** One figure per measure: a bar at the median, a dot per run, the value at the bar's end. */
  function renderCharts(list: ShareMeasure[]): string {
    // Axis ends read as plain numbers for ratings, and the origin is just zero.
    const tickText = (key: ShareMeasureKey, tick: number) => (tick === 0 ? '0' : key === 'rating' ? format.number(tick) : valueText(key, tick))
    const figures = list.map((measure) => {
      const max = Math.max(0, ...measure.values.flatMap((value) => value.values))
      const ceiling = measure.key === 'passRate' ? 1 : measure.key === 'rating' ? 5 : niceCeiling(max)
      if (ceiling <= 0) return null
      const at = (value: number) => Math.min(100, (value / ceiling) * 100)
      const ticks = [0, ceiling / 2, ceiling]
      const hairlines = ticks.map((tick) => `<i class="tick" style="left:${at(tick)}%"></i>`).join('')
      const rows = variants.map((_, index) => {
        const value = measure.values[index]!
        const text = value.median === null ? null : valueText(measure.key, value.median)
        const dots = measure.key !== 'passRate' && value.values.length > 1
          ? value.values.map((entry) => `<b class="cdot" style="left:${at(entry)}%"></b>`).join('')
          : ''
        const weak = value.eligible ? '' : ` <small>${e(t('export.bench.failedOnly'))}</small>`
        // The value sits past the rightmost mark, so a slower run's dot never covers it.
        const end = value.median === null ? 0 : at(Math.max(value.median, ...(dots ? value.values : [])))
        const bar = value.median === null
          ? `<span class="cval" style="left:0">–</span>`
          : `<i class="cbar" style="width:${at(value.median)}%"></i>${dots}<span class="cval" style="left:${end}%">${e(text!)}${weak}</span>`
        return `<div class="crow${measure.best === index ? ' best' : ''}" data-index="${index}"><span class="cname"><span class="letter">${letterOf(index)}</span>${variantName(index, 'span', ' class="n"')}</span><span class="ctrack">${hairlines}${bar}</span></div>`
      }).join('')
      const axis = `<div class="crow caxis" aria-hidden="true"><span></span><span class="ctrack">${ticks.map((tick, index) => `<span style="left:${at(tick)}%;transform:translateX(${index === 0 ? '0' : index === ticks.length - 1 ? '-100%' : '-50%'})">${e(tickText(measure.key, tick))}</span>`).join('')}</span></div>`
      const caption = [directionNote(measure), repetitions.length > 1 && measure.key !== 'passRate' ? fill(t('export.bench.chartRuns'), { count: repetitions.length }) : ''].filter(Boolean).join(' ')
      return { measure, html: `<figure class="chart" data-chart="${measure.key}"><figcaption><strong>${e(t(MEASURE_LABELS[measure.key]))}</strong><span>${e(caption)}</span></figcaption>${rows}${axis}</figure>` }
    }).filter((figure): figure is { measure: ShareMeasure; html: string } => figure !== null)
    if (figures.length === 0) return ''
    const switcher = figures.length > 1
      ? `<div class="seg chart-switch" role="group" aria-label="${e(t('export.bench.chartMeasure'))}" data-controls hidden>${figures.map(({ measure }) => `<button type="button" data-chart-btn="${measure.key}" aria-pressed="false">${e(t(MEASURE_LABELS[measure.key]))}</button>`).join('')}</div>`
      : ''
    return `<div class="charts" data-charts>${switcher}${figures.map((figure) => figure.html).join('')}</div>`
  }

  // --- Final messages --------------------------------------------------------------

  // Lanes without a production already read as the response: listing it twice would be noise.
  const spoken = options.includeResponses ? page.runs.filter((item) => item.mode !== 'none' && item.run.response) : []
  const said = spoken.length
    ? `<section class="said column"><h2 class="section">${e(t('export.bench.responses'))}</h2>` +
      repetitions
        .flatMap((repetition) =>
          variants.map((variant, index) => {
            const item = runOf(variant, repetition)
            if (!item || !spoken.includes(item)) return ''
            return `<details data-rep-item data-rep="${repetition}" data-index="${index}"><summary><span class="letter">${letterOf(index)}</span>${variantName(index, 'span')}</summary>${response(item)}</details>`
          }),
        )
        .join('') +
      '</section>'
    : ''

  const lead = variants.length > 1 ? fill(t('export.bench.lead'), { count: variants.length }) : t('export.bench.leadSingle')
  const title = options.title
  const slides = page.links.slides
    ? `<a class="pill" href="${e(page.links.slides)}">${ICONS.play}${e(t('export.bench.slides'))}</a>`
    : ''

  return (
    `<!doctype html><html lang="${options.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(lead)}">` +
    `<title>${e(title)} · Sillage</title><style>${css}</style></head><body>` +
    `<div class="column"><div class="top"><span class="brand">${logo}Sillage</span><span class="top-end">${slides}<span>${e(format.date(page.sharedAt))}</span></span></div>` +
    `<header class="intro"><p class="kicker">${e(t('export.bench.kicker'))}</p><h1>${e(title)}</h1><p class="lead">${e(lead)}</p>` +
    (options.note ? `<p class="note">${e(options.note)}</p>` : '') +
    (options.includePrompt
      ? `<section class="brief"><h2>${e(t('export.bench.prompt'))}</h2><p class="prompt-text" data-prompt>${e(benchmark.prompt)}</p><button type="button" class="link" data-prompt-more hidden>${e(t('export.bench.promptMore'))}</button></section>`
      : '') +
    `</header></div>` +
    `<section class="bleed"><div class="stage-head"><div><h2 class="section">${e(t('export.bench.productions'))}</h2>${options.blind ? `<p>${e(t('export.bench.blindNote'))}</p>` : ''}</div>${controls}</div>` +
    lineup +
    `<div class="tabs" role="tablist" data-tabs hidden>${tabs}</div><div class="stage" data-stage>${lanes.join('')}</div></section>` +
    numbers + said +
    `<footer class="column"><span class="brand">${logo}${e(t('export.page.signature'))}</span><p>${e(t('export.bench.footer'))}</p>` +
    `<a href="https://marlburrow.github.io/sillage/" target="_blank" rel="noopener noreferrer">${e(t('export.page.discover'))}</a></footer>` +
    `<script type="application/json" id="bench-data">${jsonBlock(data)}</script>` +
    `<script>${script}</script></body></html>`
  )
}

export function renderShareUnavailable(locale: 'en' | 'fr'): string {
  const t = exportText(locale)
  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">` +
    `<title>${escapeHtml(t('export.bench.unavailable'))} · Sillage</title><style>${css}</style></head><body><div class="column"><div class="top"><span class="brand">${logo}Sillage</span></div>` +
    `<header class="intro"><h1>${escapeHtml(t('export.bench.unavailable'))}</h1><p class="lead">${escapeHtml(t('export.page.unavailableHint'))}</p></header></div></body></html>`
  )
}
