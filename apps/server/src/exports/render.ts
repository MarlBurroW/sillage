import MarkdownIt from 'markdown-it'
import { EXPORT_MAX_BYTES, type AgentKind } from '@sillage/protocol'
import { badRequest } from '../http/errors.js'
import { exportText } from './labels.js'
import { toolCategory, type ExportDocument } from './source.js'

export const EXPORT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
export const EXPORT_SANDBOX = 'sandbox allow-popups allow-popups-to-escape-sandbox'
const agents: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok Build', antigravity: 'Antigravity' }
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)
}
const logo = '<svg viewBox="0 0 100 100" width="27" height="27" fill="currentColor" aria-hidden="true"><path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79ZM23 79C47 79 39 21 65 21H78C54 21 62 79 36 79ZM42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z"/></svg>'
const css = `
:root{color-scheme:light dark;--bg:#faf7fb;--surface:#fff;--ink:#211925;--muted:#6d6172;--line:#e5dce8;--accent:#85409b;--code:#f0e9f2}
@media(prefers-color-scheme:dark){:root{--bg:#0f0b11;--surface:#1e1820;--ink:#eee8f0;--muted:#b5aab9;--line:#322936;--accent:#cd7be5;--code:#261f28}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:2rem}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.7 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:5px}
.brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:650;color:var(--ink);text-decoration:none;letter-spacing:-.03em}.top{max-width:1180px;margin:auto;padding:2rem 2.5rem 0}
.layout{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:190px minmax(0,1fr);gap:3rem;padding:0 2.5rem 4rem}
header{grid-column:2;position:relative;padding:3.5rem 0 2.5rem;border-bottom:1px solid var(--line)}.kicker{font-size:.88rem;color:var(--muted);margin:0 0 .9rem}
h1{font-size:clamp(2rem,4.5vw,3.4rem);line-height:1.13;letter-spacing:-.045em;font-weight:650;margin:0 0 1.4rem;max-width:22ch}
.intro{max-width:65ch;color:var(--muted);font-size:1.12rem}.meta{font-size:.82rem;color:var(--muted);margin-top:1.4rem}.agent{display:inline-flex;align-items:center;gap:.4rem}.agent:before{content:"";width:6px;height:6px;background:var(--accent);border-radius:50%}
aside{grid-column:1;grid-row:2;align-self:start;position:sticky;top:2rem;max-height:85vh;overflow:auto;font-size:.8rem}aside summary{font-weight:650;cursor:pointer;color:var(--muted)}
nav ol{list-style:none;padding:0;margin:1rem 0}nav li{margin:.75rem 0}nav a{color:var(--muted);text-decoration:none;display:block;line-height:1.5}nav a:hover{color:var(--accent)}
main{grid-column:2;min-width:0;max-width:78ch}.exchange{padding:1.4rem 0 1.8rem;scroll-margin-top:2rem}.exchange.user{margin:1.5rem 0;padding:1rem 1.25rem;background:var(--surface);border-left:3px solid var(--accent)}
.speaker{font-size:.8rem;line-height:1.4;font-weight:650;color:var(--muted);margin:0 0 1rem;display:flex;align-items:center;gap:.65rem}.speaker .number{font-variant-numeric:tabular-nums;color:var(--accent)}.prose>:first-child{margin-top:0}.prose>:last-child{margin-bottom:0}
.prose h1{font-size:1.7rem;letter-spacing:-.02em}.prose h2{font-size:1.35rem;line-height:1.4;margin:1.8em 0 .7em}.prose h3{font-size:1.08rem;margin:1.5em 0 .6em}.prose p{margin:0 0 1em}
.prose li{margin:.3em 0}.prose ul,.prose ol{padding-left:1.5em}.prose blockquote{margin:1.2rem 0;padding:.2rem 1rem;border-left:2px solid var(--line);color:var(--muted)}
pre{background:var(--code);padding:1rem 1.2rem;overflow:auto;border-radius:6px;max-width:100%;font-size:.8rem;line-height:1.65;tab-size:2}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}p code,li code{font-size:.86em;background:var(--code);padding:.12em .3em;border-radius:3px}
.table-wrap{overflow:auto;margin:1.2rem 0}table{border-collapse:collapse;min-width:100%;font-size:.87rem}th,td{text-align:left;padding:.65rem .8rem;border-bottom:1px solid var(--line)}th{font-weight:650;background:var(--surface)}
.activity{margin:.5rem 0 1.5rem;border-block:1px solid var(--line);padding:.8rem 0;color:var(--muted);font-size:.85rem}.activity summary{cursor:pointer}.activity article{padding:.8rem 0}.activity h3{font-size:.85rem;font-weight:550}.activity pre{color:var(--ink)}
figure{margin:1.5rem 0}figure img{display:block;width:auto;max-width:100%;height:auto;margin:auto;border:1px solid var(--line);border-radius:6px}figcaption{font-size:.8rem;color:var(--muted);padding:.65rem 0}.note,.gap{font-size:.78rem;color:var(--muted)}.gap{padding:1rem 0;border-block:1px dashed var(--line);margin:1rem 0}
footer{grid-column:2;border-top:1px solid var(--line);padding-top:2rem;font-size:.85rem;color:var(--muted)}footer p{margin:.5rem 0 1rem}footer .discover{display:inline-block;color:var(--accent);font-weight:600}
@media(max-width:850px){.layout{grid-template-columns:minmax(0,1fr);gap:1.2rem;padding:0 1.25rem 2.5rem}.top{padding:1.2rem 1.25rem 0}header,main,footer,aside{grid-column:1}header{padding:2.5rem 0 1.5rem}aside{grid-row:auto;position:static;max-height:12rem}body{font-size:16px}aside nav{max-height:9rem;overflow:auto}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{:root{color-scheme:light;--bg:white;--surface:white;--ink:black;--muted:#444;--line:#ccc;--accent:#623071;--code:#f4f4f4}.layout{display:block;padding:0}.top,aside{display:none}header{padding:0 0 1rem}body{font-size:11pt}pre{white-space:pre-wrap;overflow-wrap:anywhere}details::details-content{content-visibility:visible}figure,pre{break-inside:avoid}a{color:inherit}footer{margin-top:2rem}}
`

export function renderUnavailable(locale: 'en' | 'fr'): string {
  const t = exportText(locale)
  return '<!doctype html><html lang="' + locale + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(t('export.page.unavailable')) + ' · Sillage</title><style>' + css + '</style></head><body>' +
    '<div class="top"><span class="brand">' + logo + 'Sillage</span></div><div class="layout"><header><h1>' + escapeHtml(t('export.page.unavailable')) +
    '</h1><p class="intro">' + escapeHtml(t('export.page.unavailableHint')) + '</p></header></div></body></html>'
}

export function renderExport(document: ExportDocument, masked: Map<string, string>, agent: AgentKind, publicRoot: string): string {
  const t = exportText(document.options.locale)
  const e = escapeHtml
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  md.linkify.set({ fuzzyLink: false })
  const validateLink = md.validateLink.bind(md)
  const publicLink = (url: string) => {
    if (!/^https?:\/\//i.test(url) || !validateLink(url)) return false
    try { return !publicRoot || new URL(url).origin !== new URL(publicRoot).origin } catch { return false }
  }
  // Parse every image destination so excluded images cannot survive as literal Markdown.
  // Links are checked at rendering time; no untrusted HTML is accepted.
  md.validateLink = () => true
  md.renderer.rules.image = () => ''
  md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
    if (!publicLink(tokens[index]!.attrGet('href') ?? '')) return '<span>'
    tokens[index]!.attrSet('target', '_blank')
    tokens[index]!.attrSet('rel', 'noopener noreferrer')
    return self.renderToken(tokens, index, options)
  }
  md.renderer.rules.link_close = (tokens, index) => {
    for (let i = index - 1; i >= 0; i--) {
      if (tokens[i]!.type === 'link_open') return publicLink(tokens[i]!.attrGet('href') ?? '') ? '</a>' : '</span>'
    }
    return '</span>'
  }
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>'
  md.renderer.rules.table_close = () => '</table></div>'
  const get = (id: string) => masked.get(id) ?? ''
  const title = get('title'), author = get('author') || t('export.page.author')
  const toc: string[] = [], body: string[] = []
  let count = 0, toolRows: string[] = []
  const flush = () => {
    if (!toolRows.length) return
    body.push('<details class="activity"><summary>' + e(t('export.page.activity')) + ' (' + toolRows.length + ')</summary>' + toolRows.join('') + '</details>')
    toolRows = []
  }
  for (const entry of document.entries) {
    if (entry.tool) {
      const label = t(('export.page.' + toolCategory(entry.tool.name)) as 'export.page.read')
      toolRows.push('<article><h3>' + e(label) + '</h3>' + entry.fields.map(field =>
        '<details><summary>' + e(t(field.kind === 'input' ? 'export.page.input' : 'export.page.output')) + '</summary><pre><code>' + e(get(field.id)) + '</code></pre></details>').join('') +
        (entry.partial ? '<p class="note">' + e(t('export.page.partial')) + '</p>' : '') + '</article>')
      continue
    }
    flush()
    if (entry.kind === 'gap') { body.push('<p class="gap">' + e(t('export.page.gap')) + '</p>'); continue }
    count++
    const anchor = 'exchange-' + count
    const speaker = entry.kind === 'question' ? t('export.page.question') : entry.kind === 'plan' ? t('export.page.plan') :
      entry.role === 'user' ? author : agents[agent]
    const summary = entry.fields.filter(f => f.kind !== 'caption').flatMap(f => md.parse(get(f.id), {}))
      .flatMap(token => token.type === 'inline' ? token.children ?? [] : [])
      .filter(token => token.type === 'text' || token.type === 'code_inline' || token.type === 'softbreak')
      .map(token => token.type === 'softbreak' ? ' ' : token.content).join(' ').slice(0, 90)
    if (entry.role === 'user' || !toc.length) toc.push('<li><a href="#' + anchor + '">' + e(summary || speaker) + '</a></li>')
    body.push('<section id="' + anchor + '" class="exchange ' + entry.role + '"><p class="speaker"><span class="number">' + String(count).padStart(2, '0') +
      '</span>' + e(speaker) + '</p><div class="prose">' + entry.fields.filter(f => f.kind !== 'caption').map(f => md.render(get(f.id))).join('') +
      '</div>' + entry.images.map(image => '<figure><img loading="lazy" src="' + image.data + '" alt="' + e(get(image.id + '.caption')) + '">' +
        (get(image.id + '.caption') ? '<figcaption>' + e(get(image.id + '.caption')) + '</figcaption>' : '') + '</figure>').join('') +
      (entry.partial ? '<p class="note">' + e(t('export.page.partial')) + '</p>' : '') + '</section>')
  }
  flush()
  const html = '<!doctype html><html lang="' + document.options.locale + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="' + e(EXPORT_CSP) + '">' +
    '<title>' + e(title) + ' · Sillage</title><style>' + css + '</style></head><body><div class="top"><span class="brand">' + logo + 'Sillage</span></div><div class="layout">' +
    '<header><p class="kicker">' + e(t('export.page.kicker')) + '</p><h1>' + e(title) + '</h1>' +
    (get('introduction') ? '<div class="intro prose">' + md.render(get('introduction')) + '</div>' : '') +
    '<div class="meta"><span class="agent">' + e(agents[agent]) + '</span>' +
    (document.excerpt ? '<p>' + e(t('export.page.excerpt')) + '</p>' : '') + '</div></header>' +
    '<aside><details open><summary>' + e(t('export.page.contents')) + '</summary><nav aria-label="' + e(t('export.page.contents')) + '"><ol>' + toc.join('') + '</ol></nav></details></aside>' +
    '<main>' + body.join('') + '</main><footer><span class="brand">' + logo + e(t('export.page.signature')) + '</span><p>' + e(t('export.page.footer')) +
    '</p><a class="discover" href="https://marlburrow.github.io/sillage/" target="_blank" rel="noopener noreferrer">' + e(t('export.page.discover')) + '</a></footer></div></body></html>'
  if (Buffer.byteLength(html) > EXPORT_MAX_BYTES) throw badRequest('export_too_large', 'Export is too large.')
  return html
}
