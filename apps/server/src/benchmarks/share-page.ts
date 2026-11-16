import { createHash } from 'node:crypto'
import MarkdownIt from 'markdown-it'
import {
  deliverableKind,
  variantAgent,
  type BenchmarkDto,
  type BenchmarkExportBlocker,
  type BenchmarkExportMode,
  type BenchmarkRunDto,
  type BenchmarkShareOptions,
  type BenchmarkVariant,
} from '@sillage/protocol'
import { exportText } from '../exports/labels.js'
import { agents, escapeHtml } from '../exports/render.js'
import type { RunFile } from './exportability.js'

/**
 * The page a shared benchmark is read on: the prompt, what each variant produced running live
 * side by side, the measurements, the final messages. One self-contained document with relative
 * links to the copied productions, so the same bytes work behind a public link and unzipped on a
 * disk.
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
}

const logo = '<svg viewBox="0 0 100 100" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79ZM23 79C47 79 39 21 65 21H78C54 21 62 79 36 79ZM42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z"/></svg>'

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
const ICONS = {
  reload: icon('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  open: icon('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  expand: icon('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>'),
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
.brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:650;font-size:1rem;color:var(--ink);letter-spacing:-.03em}
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
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:2px}
.seg button{border:0;background:none;color:var(--muted);font:inherit;font-size:.85rem;padding:.3rem .7rem;border-radius:6px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}
.pill,select.pill{border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;font-size:.85rem;padding:.38rem .75rem;cursor:pointer}
.pill[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
.bleed{padding:0 clamp(.75rem,2vw,2rem)}
.tabs{display:flex;gap:.4rem;overflow-x:auto;padding-bottom:.8rem}
.tabs button{display:inline-flex;align-items:center;gap:.5rem;flex:none;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--muted);font:inherit;font-size:.88rem;padding:.3rem .8rem .3rem .3rem;cursor:pointer}
.tabs button[aria-selected=true]{border-color:var(--accent);color:var(--ink)}
.letter{display:inline-grid;place-items:center;flex:none;width:1.7rem;height:1.7rem;border-radius:5px;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:.9rem;line-height:1}
.stage{display:grid;gap:1rem;grid-template-columns:minmax(0,1fr)}
.js .stage[data-layout=side]{grid-auto-flow:column;grid-template-columns:none;grid-auto-columns:minmax(min(86vw,26rem),1fr);overflow-x:auto;scroll-snap-type:x proximity;padding-bottom:.6rem}
.lane{display:flex;flex-direction:column;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden;scroll-snap-align:start}
.lane-bar{display:flex;align-items:center;gap:.7rem;padding:.55rem .6rem .55rem .7rem;border-bottom:1px solid var(--line)}
.who{min-width:0;flex:1;line-height:1.25}.who strong{display:block;font-size:.95rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.who span{display:block;font-size:.78rem;color:var(--muted)}
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
.pass{color:var(--good)}.fail{color:var(--bad)}
.foot{font-size:.82rem;color:var(--muted);margin:.9rem 0 0;max-width:70ch}
.said{padding-top:clamp(3rem,7vw,5rem)}.said details{border-bottom:1px solid var(--line)}.said details:first-of-type{margin-top:1.2rem;border-top:1px solid var(--line)}
.said summary{display:flex;align-items:center;gap:.7rem;padding:.8rem 0;cursor:pointer;font-weight:650;list-style:none}.said summary::-webkit-details-marker{display:none}
.said summary:after{content:"+";margin-left:auto;color:var(--muted);font-weight:400;font-size:1.2rem}.said details[open] summary:after{content:"–"}
.said .prose{padding:.2rem 0 1.6rem;max-width:78ch}
footer.column{margin-top:clamp(3.5rem,8vw,6rem);border-top:1px solid var(--line);padding-top:2rem;padding-bottom:3rem;font-size:.85rem;color:var(--muted)}footer p{margin:.5rem 0 .9rem}footer a{font-weight:600}
@media(max-width:820px){.lane-body{height:72vh}.stage-head{align-items:start}}
@media print{.controls,.tabs,.acts{display:none}.lane-body{height:60vh}}
`

/**
 * Behaviour of the page, constant so its hash can be pinned in the policy: every label it swaps
 * comes from a `data-` attribute. Without it the page still reads top to bottom, lanes stacked.
 */
const script = `(()=>{const d=document,q=(s,r=d)=>[...r.querySelectorAll(s)];d.documentElement.classList.add('js');
const p=d.querySelector('[data-prompt]'),more=d.querySelector('[data-prompt-more]');
if(p){if(more&&p.scrollHeight>p.clientHeight+8){more.hidden=false;more.addEventListener('click',()=>{p.classList.add('open');more.hidden=true})}else p.classList.add('open')}
const reveal=d.querySelector('[data-reveal]');
if(reveal){let shown=false;reveal.addEventListener('click',()=>{shown=!shown;q('[data-real]').forEach(e=>{e.textContent=shown?e.dataset.real:e.dataset.blind});reveal.textContent=shown?reveal.dataset.hide:reveal.dataset.show;reveal.setAttribute('aria-pressed',String(shown))})}
const stage=d.querySelector('[data-stage]');if(!stage)return;
const lanes=q('[data-lane]',stage),tabs=q('[data-tab]'),tablist=d.querySelector('[data-tabs]'),reps=d.querySelector('[data-rep-select]');
const s={layout:'side',rep:lanes[0]?lanes[0].dataset.rep:'1',active:lanes[0]?lanes[0].dataset.variant:'0',width:'full'};
if(matchMedia('(max-width:820px)').matches||tabs.length>4)s.layout='one';
const apply=()=>{stage.dataset.layout=s.layout;stage.dataset.width=s.width;
lanes.forEach(l=>{l.hidden=l.dataset.rep!==s.rep||(s.layout==='one'&&l.dataset.variant!==s.active)});
q('[data-rep-item]').forEach(e=>{e.hidden=e.dataset.rep!==s.rep});
q('[data-layout-btn]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.layoutBtn===s.layout)));
q('[data-width-btn]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.widthBtn===s.width)));
if(tablist)tablist.hidden=s.layout!=='one';
tabs.forEach(t=>{const on=t.dataset.tab===s.active;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1})};
q('[data-layout-btn]').forEach(b=>b.addEventListener('click',()=>{s.layout=b.dataset.layoutBtn;apply()}));
q('[data-width-btn]').forEach(b=>b.addEventListener('click',()=>{s.width=b.dataset.widthBtn;apply()}));
tabs.forEach((t,i)=>{t.addEventListener('click',()=>{s.active=t.dataset.tab;apply()});
t.addEventListener('keydown',e=>{const step=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!step)return;e.preventDefault();const next=tabs[(i+step+tabs.length)%tabs.length];s.active=next.dataset.tab;apply();next.focus()})});
if(reps)reps.addEventListener('change',()=>{s.rep=reps.value;apply()});
const close=()=>{q('.lane.max').forEach(l=>{l.classList.remove('max');const b=l.querySelector('[data-expand]');if(b){b.setAttribute('aria-label',b.dataset.expand);b.title=b.dataset.expand}});d.body.classList.remove('locked')};
q('[data-expand]').forEach(b=>b.addEventListener('click',()=>{const l=b.closest('[data-lane]');if(l.classList.contains('max')){close();return}close();l.classList.add('max');d.body.classList.add('locked');b.setAttribute('aria-label',b.dataset.collapse);b.title=b.dataset.collapse}));
q('[data-reload]').forEach(b=>b.addEventListener('click',()=>{const f=b.closest('[data-lane]').querySelector('iframe');if(f)f.src=f.getAttribute('src')}));
d.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
q('[data-controls]').forEach(c=>{c.hidden=false});apply()})()`

const scriptHash = createHash('sha256').update(script).digest('base64')

/**
 * Policy of the page itself: only its own pinned script runs, and it may only frame and load the
 * productions served beside it. The productions carry their own sandbox policy.
 */
export const SHARE_PAGE_CSP =
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; img-src 'self' data:; ` +
  `media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

/** Attribute given to every embedded production: scripts run, in an origin that owns nothing. */
const FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock'

const TERMINAL_FAILURES = new Set(['failed', 'timed_out', 'cancelled'])

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function formatters(locale: 'en' | 'fr') {
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  return {
    duration(ms: number): string {
      if (ms < 1000) return `${Math.round(ms)} ms`
      const seconds = ms / 1000
      if (seconds < 10) return `${plain.format(seconds)} s`
      if (seconds < 60) return `${Math.round(seconds)} s`
      const minutes = Math.floor(seconds / 60)
      const rest = Math.round(seconds - minutes * 60)
      if (minutes < 60) return rest ? `${minutes} min ${String(rest).padStart(2, '0')} s` : `${minutes} min`
      return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
    },
    tokens: (count: number) => compact.format(count),
    cost: (usd: number) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: usd < 0.1 ? 3 : 2 }).format(usd),
    number: (value: number) => plain.format(value),
    date: (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(ts),
  }
}

function runTokens(run: BenchmarkRunDto): number | null {
  const metrics = run.metrics
  if (!metrics || (metrics.inputTokens === null && metrics.outputTokens === null)) return null
  return (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0)
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

export function renderBenchmarkShare(page: SharePage): string {
  const { benchmark, options } = page
  const t = exportText(options.locale)
  const e = escapeHtml
  const format = formatters(options.locale)

  const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  md.linkify.set({ fuzzyLink: false })
  // An agent's message may point at local images or paths: only real web links stay clickable.
  md.renderer.rules.image = () => ''
  md.renderer.rules.link_open = (tokens, index, opts, _env, self) => {
    if (!/^https?:\/\//i.test(tokens[index]!.attrGet('href') ?? '')) return '<span>'
    tokens[index]!.attrSet('target', '_blank')
    tokens[index]!.attrSet('rel', 'noopener noreferrer')
    return self.renderToken(tokens, index, opts)
  }
  md.renderer.rules.link_close = (tokens, index) => {
    for (let i = index - 1; i >= 0; i--) {
      if (tokens[i]!.type === 'link_open') return /^https?:\/\//i.test(tokens[i]!.attrGet('href') ?? '') ? '</a>' : '</span>'
    }
    return '</span>'
  }
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>'
  md.renderer.rules.table_close = () => '</table></div>'

  const variants = page.order
    .map((id) => benchmark.variants.find((variant) => variant.id === id))
    .filter((variant): variant is BenchmarkVariant => !!variant)
  const letterOf = (index: number) => String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : '')

  /** Text that a blind page hides until revealed. The real value stays in the markup: this is a game, not a secret. */
  const named = (tag: string, real: string, blind: string, attrs = '') =>
    options.blind
      ? `<${tag}${attrs} data-real="${e(real)}" data-blind="${e(blind)}">${e(blind)}</${tag}>`
      : `<${tag}${attrs}>${e(real)}</${tag}>`
  const variantName = (index: number, tag = 'strong') =>
    named(tag, variants[index]!.label, fill(t('export.bench.variant'), { letter: letterOf(index) }))
  const agentName = (index: number, tag = 'span') => named(tag, agents[variantAgent(variants[index]!)], ' ')

  const repetitions = [...new Set(page.runs.map((item) => item.run.repetition))].sort((a, b) => a - b)
  const runOf = (variant: BenchmarkVariant, repetition: number) =>
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
      const caption = `<figcaption><span>${e(file.path)}</span><a href="${e(url)}" download>${e(t('export.bench.download'))}</a></figcaption>`
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
    const tokens = runTokens(run)
    let body: string
    let actions = ''
    if (item.mode === 'page' && item.dir && item.entry) {
      const url = `${item.dir}/${encodePath(item.entry)}`
      // The title names the variant as the reader sees it; a blind page must not leak it to a tooltip.
      body = `<div class="lane-body"><iframe src="${e(url)}" sandbox="${FRAME_SANDBOX}" loading="lazy" title="${e(fill(t('export.bench.variant'), { letter: letterOf(index) }))}"></iframe></div>`
      actions =
        `<button type="button" data-reload aria-label="${e(t('export.bench.reload'))}" title="${e(t('export.bench.reload'))}">${ICONS.reload}</button>` +
        `<a href="${e(url)}" target="_blank" rel="noopener noreferrer" aria-label="${e(t('export.bench.open'))}" title="${e(t('export.bench.open'))}">${ICONS.open}</a>`
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
      `<header class="lane-bar"><span class="letter">${letterOf(index)}</span><div class="who">${variantName(index)}${agentName(index)}</div>${failure}` +
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

  // --- Numbers -------------------------------------------------------------------

  let numbers = ''
  if (options.includeMetrics) {
    const rows = variants.map((variant) => {
      const runs = page.runs.map((item) => item.run).filter((run) => run.variantId === variant.id && run.metrics)
      const checks = runs.filter((run) => run.check)
      const ratings = runs.map((run) => run.rating).filter((rating): rating is number => rating !== null)
      return {
        duration: median(runs.map((run) => run.metrics!.durationMs).filter((value): value is number => value !== null)),
        tokens: median(runs.map(runTokens).filter((value): value is number => value !== null)),
        cost: median(runs.map((run) => run.metrics!.costUsd).filter((value): value is number => value !== null)),
        tools: median(runs.map((run) => run.metrics!.toolCalls)),
        check: checks.length ? { passed: checks.filter((run) => run.check!.passed).length, total: checks.length } : null,
        rating: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
      }
    })
    type Row = (typeof rows)[number]
    const measured = (key: 'duration' | 'tokens' | 'cost' | 'tools', render: (value: number) => string) => {
      const values = rows.map((row) => row[key]).filter((value): value is number => value !== null)
      const max = Math.max(...values, 0)
      const min = Math.min(...values)
      return (row: Row) => {
        const value = row[key]
        if (value === null) return '<td>–</td>'
        const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
        // Lower is better on every measured column, and a lead only means something among several.
        const best = values.length > 1 && value === min && min !== max
        return `<td${best ? ' class="best"' : ''}>${e(render(value))}<span class="bar"><i style="width:${width}%"></i></span></td>`
      }
    }
    const columns: { label: string; cell: (row: Row) => string; show: boolean }[] = [
      { label: t('export.bench.col.duration'), cell: measured('duration', format.duration), show: rows.some((row) => row.duration !== null) },
      { label: t('export.bench.col.tokens'), cell: measured('tokens', format.tokens), show: rows.some((row) => row.tokens !== null) },
      { label: t('export.bench.col.cost'), cell: measured('cost', format.cost), show: rows.some((row) => row.cost !== null) },
      { label: t('export.bench.col.tools'), cell: measured('tools', format.number), show: rows.some((row) => row.tools !== null) },
      {
        label: t('export.bench.col.check'),
        show: rows.some((row) => row.check),
        cell: (row) =>
          row.check
            ? `<td class="${row.check.passed === row.check.total ? 'pass' : 'fail'}">${e(fill(t('export.bench.checkPassed'), row.check))}</td>`
            : '<td>–</td>',
      },
      {
        label: t('export.bench.col.rating'),
        show: options.includeRatings && rows.some((row) => row.rating !== null),
        cell: (row) => (row.rating === null ? '<td>–</td>' : `<td>${e(format.number(row.rating))} / 5</td>`),
      },
    ]
    const shown = columns.filter((column) => column.show)
    if (shown.length > 0) {
      const notes = [
        repetitions.length > 1 ? fill(t('export.bench.median'), { count: repetitions.length }) : '',
        rows.some((row) => row.cost !== null) ? t('export.bench.costNote') : '',
      ].filter(Boolean)
      numbers =
        `<section class="numbers column"><h2 class="section">${e(t('export.bench.numbers'))}</h2><div class="table-wrap"><table><thead><tr><th>${e(t('export.bench.col.variant'))}</th>${shown.map((column) => `<th>${e(column.label)}</th>`).join('')}</tr></thead><tbody>` +
        rows.map((row, index) => `<tr><td class="name"><div class="name-row"><span class="letter">${letterOf(index)}</span><div>${variantName(index)}${agentName(index, 'small')}</div></div></td>${shown.map((column) => column.cell(row)).join('')}</tr>`).join('') +
        `</tbody></table></div>${notes.length ? `<p class="foot">${e(notes.join(' '))}</p>` : ''}</section>`
    }
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
            return `<details data-rep-item data-rep="${repetition}"><summary><span class="letter">${letterOf(index)}</span>${variantName(index, 'span')}</summary>${response(item)}</details>`
          }),
        )
        .join('') +
      '</section>'
    : ''

  const lead = variants.length > 1 ? fill(t('export.bench.lead'), { count: variants.length }) : t('export.bench.leadSingle')
  const title = options.title

  return (
    `<!doctype html><html lang="${options.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(lead)}">` +
    `<title>${e(title)} · Sillage</title><style>${css}</style></head><body>` +
    `<div class="column"><div class="top"><span class="brand">${logo}Sillage</span><span>${e(format.date(page.sharedAt))}</span></div>` +
    `<header class="intro"><p class="kicker">${e(t('export.bench.kicker'))}</p><h1>${e(title)}</h1><p class="lead">${e(lead)}</p>` +
    (options.note ? `<p class="note">${e(options.note)}</p>` : '') +
    (options.includePrompt
      ? `<section class="brief"><h2>${e(t('export.bench.prompt'))}</h2><p class="prompt-text" data-prompt>${e(benchmark.prompt)}</p><button type="button" class="link" data-prompt-more hidden>${e(t('export.bench.promptMore'))}</button></section>`
      : '') +
    `</header></div>` +
    `<section class="bleed"><div class="stage-head"><div><h2 class="section">${e(t('export.bench.productions'))}</h2>${options.blind ? `<p>${e(t('export.bench.blindNote'))}</p>` : ''}</div>${controls}</div>` +
    `<div class="tabs" role="tablist" data-tabs hidden>${tabs}</div><div class="stage" data-stage>${lanes.join('')}</div></section>` +
    numbers + said +
    `<footer class="column"><span class="brand">${logo}${e(t('export.page.signature'))}</span><p>${e(t('export.bench.footer'))}</p>` +
    `<a href="https://marlburrow.github.io/sillage/" target="_blank" rel="noopener noreferrer">${e(t('export.page.discover'))}</a></footer>` +
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
