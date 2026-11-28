#!/usr/bin/env node
/*
 * Builds the translated pages of the website from the English ones. The English pages in site/
 * stay the source edited by hand. Each language has a catalog in scripts/site-i18n/<lang>/, one
 * JSON file per page plus _shared.json, mapping every English text to its translation. A text is
 * the content of an element that holds only text and inline markup; its inline tags are reduced
 * to numbered placeholders (<0>…</0>, <1/>), so a translation can move them but never rewrites
 * a class or a link. The build writes site/<lang>/<page>.html: same markup, translated texts and
 * attributes, paths leading back to the shared assets, and the language switch pointing back.
 *
 *   node scripts/site-i18n.mjs            build; fails when a text has no translation
 *   node scripts/site-i18n.mjs --extract  add new English texts to the catalogs, drop unused ones
 *   node scripts/site-i18n.mjs --check    fail when a built page or a translation is out of date
 *   node scripts/site-i18n.mjs --lenient  build, keeping English where a translation is missing
 *
 * Generated regions (<!-- name --> … <!-- /name -->) are copied as they are: the changelog script
 * fills them in every language afterwards. No dependencies: the Pages workflow runs it as is.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { fillCurrents } from './site-currents.mjs'

const site = new URL('../site/', import.meta.url)
const catalogs = new URL('./site-i18n/', import.meta.url)
const origin = 'https://marlburrow.github.io/sillage/'
const PAGES = ['index.html', 'features.html', 'agents.html', 'download.html', 'docs.html', 'changelog.html', 'security.html', '404.html']
const LANGUAGES = {
  fr: { locale: 'fr_FR', switchLabel: 'English version', name: 'Français' },
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW = new Set(['script', 'style'])
// Inline elements a text may contain. The opaque ones are kept whole: icons, images, code.
const INLINE = new Set(['a', 'abbr', 'b', 'br', 'code', 'em', 'i', 'img', 'kbd', 'mark', 'picture', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'svg', 'time', 'u', 'wbr'])
const OPAQUE = new Set(['br', 'code', 'img', 'kbd', 'picture', 'svg', 'wbr'])
const TRANSLATED_ATTRIBUTES = new Set(['alt', 'title', 'aria-label', 'placeholder'])
const TRANSLATED_META = new Set(['description', 'og:title', 'og:description', 'twitter:title', 'twitter:description'])
const URL_ATTRIBUTES = new Set(['href', 'src', 'poster', 'data-poster'])

/* A small parser for the site's own, well-formed HTML: elements with the offsets of their tags. */

function readTag(html, start) {
  let index = start + 1
  const name = /^[a-zA-Z][\w:-]*/.exec(html.slice(index, index + 64))[0]
  index += name.length
  const attrs = []
  for (;;) {
    while (/\s/.test(html[index])) index++
    if (html[index] === '>') return { name: name.toLowerCase(), attrs, end: index + 1, selfClosing: false }
    if (html[index] === '/' && html[index + 1] === '>') return { name: name.toLowerCase(), attrs, end: index + 2, selfClosing: true }
    const attrName = /^[^\s=>/]+/.exec(html.slice(index, index + 256))[0]
    index += attrName.length
    let valueStart = -1
    let valueEnd = -1
    while (/\s/.test(html[index])) index++
    if (html[index] === '=') {
      index++
      while (/\s/.test(html[index])) index++
      const quote = html[index]
      if (quote === '"' || quote === "'") {
        valueStart = index + 1
        valueEnd = html.indexOf(quote, valueStart)
        index = valueEnd + 1
      } else {
        valueStart = index
        valueEnd = index + /^[^\s>]+/.exec(html.slice(index))[0].length
        index = valueEnd
      }
    }
    attrs.push({ name: attrName.toLowerCase(), value: valueStart === -1 ? null : html.slice(valueStart, valueEnd), valueStart, valueEnd })
  }
}

function parse(html) {
  const root = { type: 'element', name: '#root', attrs: [], children: [], parent: null, start: 0, openEnd: 0, closeStart: html.length, end: html.length }
  let current = root
  let index = 0
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4) + 3
      const label = html.slice(index + 4, end - 3).trim()
      const close = `<!-- /${label} -->`
      const closeAt = /^[a-z][\w:-]*$/i.test(label) ? html.indexOf(close, end) : -1
      if (closeAt !== -1) {
        current.children.push({ type: 'region', name: label, start: index, end: closeAt + close.length, parent: current })
        index = closeAt + close.length
      } else {
        current.children.push({ type: 'comment', start: index, end, parent: current })
        index = end
      }
    } else if (html.startsWith('<!', index)) {
      const end = html.indexOf('>', index) + 1
      current.children.push({ type: 'doctype', start: index, end, parent: current })
      index = end
    } else if (html.startsWith('</', index)) {
      const end = html.indexOf('>', index) + 1
      const name = html.slice(index + 2, end - 1).trim().toLowerCase()
      let node = current
      while (node && node.name !== name) node = node.parent
      if (node && node !== root) {
        node.closeStart = index
        node.end = end
        current = node.parent
      }
      index = end
    } else if (html[index] === '<' && /[a-zA-Z]/.test(html[index + 1] || '')) {
      const tag = readTag(html, index)
      const element = { type: 'element', name: tag.name, attrs: tag.attrs, children: [], parent: current, start: index, openEnd: tag.end }
      current.children.push(element)
      index = tag.end
      if (VOID.has(tag.name) || tag.selfClosing) {
        element.closeStart = element.end = tag.end
      } else if (RAW.has(tag.name)) {
        const closeAt = html.toLowerCase().indexOf(`</${tag.name}`, index)
        element.children.push({ type: 'raw', start: index, end: closeAt, parent: element })
        element.closeStart = closeAt
        element.end = html.indexOf('>', closeAt) + 1
        index = element.end
      } else {
        current = element
      }
    } else {
      let end = html.indexOf('<', index + 1)
      if (end === -1) end = html.length
      current.children.push({ type: 'text', start: index, end, parent: current })
      index = end
    }
  }
  return root
}

const attr = (element, name) => element.attrs?.find((candidate) => candidate.name === name)?.value ?? null
// Presence, for attributes written without a value such as data-lang-switch.
const hasAttr = (element, name) => Boolean(element.attrs?.some((candidate) => candidate.name === name))
// Language switches name each language in its own language: never translated, rebuilt per page.
const isLanguageSwitch = (node) => hasAttr(node, 'data-lang-switch') || hasAttr(node, 'data-lang-menu')
const isOpaque = (node) => node.type === 'element' && (OPAQUE.has(node.name) || hasAttr(node, 'data-asset-size') || isLanguageSwitch(node))

function isPhrasing(node) {
  if (node.type === 'text' || node.type === 'comment' || node.type === 'region') return true
  if (node.type !== 'element' || !INLINE.has(node.name) || isLanguageSwitch(node)) return false
  return isOpaque(node) || node.children.every(isPhrasing)
}

function hasWords(node, html) {
  if (node.type === 'text') return /\p{L}/u.test(html.slice(node.start, node.end).replace(/&[a-z]+;|&#\d+;/gi, ''))
  if (node.type !== 'element' || isOpaque(node)) return false
  return node.children.some((child) => hasWords(child, html))
}

/** Every element whose whole content is text and inline markup, outermost first. */
function findUnits(root, html) {
  const units = []
  const visit = (element) => {
    for (const child of element.children) {
      if (child.type !== 'element' || RAW.has(child.name) || isOpaque(child) || ['pre', 'svg', 'template'].includes(child.name)) continue
      if (child.children.length && child.children.every(isPhrasing) && child.children.some((node) => hasWords(node, html))) units.push(child)
      else visit(child)
    }
  }
  visit(root)
  return units
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim()

/** The text of a unit, with its inline tags numbered: what a translator sees and returns. */
function sourceOf(unit, html) {
  const tags = []
  const walk = (node) => {
    if (node.type === 'text') return html.slice(node.start, node.end)
    if (node.type === 'comment') return ''
    if (node.type === 'region') {
      tags.push({ kind: 'region', text: html.slice(node.start, node.end) })
      return `{${node.name}}`
    }
    const index = tags.length
    if (isOpaque(node)) {
      tags.push({ kind: 'opaque', text: html.slice(node.start, node.end) })
      return `<${index}/>`
    }
    tags.push({ kind: 'element', open: html.slice(node.start, node.openEnd), close: html.slice(node.closeStart, node.end) })
    return `<${index}>${node.children.map(walk).join('')}</${index}>`
  }
  const text = normalize(unit.children.map(walk).join(''))
  return { text, tags }
}

function attributeTexts(element) {
  const texts = []
  for (const { name, value } of element.attrs || []) {
    if (value === null || !value.trim()) continue
    if (TRANSLATED_ATTRIBUTES.has(name) && /\p{L}/u.test(value)) texts.push(value)
  }
  if (element.name === 'meta' && TRANSLATED_META.has(attr(element, 'name') || attr(element, 'property') || '')) {
    const content = attr(element, 'content')
    if (content) texts.push(content)
  }
  return texts
}

/** Everything translatable in a page, in document order. */
function collect(html) {
  const root = parse(html)
  const texts = []
  const units = findUnits(root, html)
  for (const unit of units) texts.push(sourceOf(unit, html).text)
  const visit = (element) => {
    for (const child of element.children) {
      if (child.type !== 'element') continue
      if (isLanguageSwitch(child)) continue
      texts.push(...attributeTexts(child))
      if (child.name === 'script' && attr(child, 'type') === 'application/ld+json') {
        const data = JSON.parse(html.slice(child.children[0].start, child.children[0].end))
        if (data.description) texts.push(data.description)
      }
      visit(child)
    }
  }
  visit(root)
  return { root, units, texts: [...new Set(texts)] }
}

/* French typography: no-break spaces before high punctuation and inside guillemets. */
function typeset(language, text) {
  if (language !== 'fr') return text
  return text.split(/(<[^>]*>)/).map((part) => (part.startsWith('<') ? part : part
    .replace(/ ([;!?])/g, ' $1')
    .replace(/ ([:»])/g, ' $1')
    .replace(/« /g, '« '))).join('')
}

function rewriteUrl(value) {
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(value)) return value
  const path = value.split(/[?#]/)[0]
  return PAGES.includes(path) ? value : `../${value}`
}

/** Social cards have a version per language: og/<lang>/home.png for the home page's og.png. */
function localizedImage(value, language) {
  if (value.endsWith('/sillage/og.png')) return value.replace(/og\.png$/, `og/${language}/home.png`)
  return value.replace(/\/og\/([\w-]+\.png)$/, `/og/${language}/$1`)
}

function pageUrl(page, language) {
  const name = page === 'index.html' ? '' : page
  return `${origin}${language ? `${language}/` : ''}${name}`
}

/** Rewrites one start tag: translated attributes, paths to shared assets, page-level metadata. */
function rewriteTag(tag, html, context) {
  const { language, page, lookup } = context
  const parsed = readTag(tag, 0)
  let out = tag
  const edits = []
  const property = parsed.attrs.find((a) => a.name === 'property' || a.name === 'name')?.value
  const rel = parsed.attrs.find((a) => a.name === 'rel')?.value
  for (const { name, value, valueStart, valueEnd } of parsed.attrs) {
    if (value === null) continue
    let next = value
    if (TRANSLATED_ATTRIBUTES.has(name) && /\p{L}/u.test(value)) next = typeset(language, lookup(value))
    else if (name === 'content' && parsed.name === 'meta' && TRANSLATED_META.has(property || '')) next = typeset(language, lookup(value))
    else if (name === 'content' && property === 'og:url') next = pageUrl(page, language)
    else if (name === 'content' && property === 'og:locale') next = LANGUAGES[language].locale
    else if (name === 'content' && property === 'og:locale:alternate') next = 'en_US'
    else if (name === 'content' && property === 'og:image') next = localizedImage(value, language)
    else if (name === 'href' && rel === 'canonical') next = pageUrl(page, language)
    else if (name === 'href' && parsed.name === 'base') next = `/sillage/${language}/`
    else if (name === 'lang' && parsed.name === 'html') next = language
    else if (URL_ATTRIBUTES.has(name) && rel !== 'alternate') next = rewriteUrl(value)
    else if (name === 'srcset') next = value.split(',').map((candidate) => candidate.trim().replace(/^\S+/, (url) => rewriteUrl(url))).join(', ')
    if (next !== value) edits.push({ start: valueStart, end: valueEnd, text: next.replace(/"/g, '&quot;') })
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

/** The footer's list of languages: the current one marked, the other one a link to the same page. */
function languageMenu(language, page, openTag) {
  return `${openTag}<a href="../${page}" hreflang="en" lang="en">English</a><span aria-current="true" lang="${language}">${LANGUAGES[language].name}</span></p>`
}

/** The language switch, pointing from this page to the same page in the other language. */
function languageSwitch(language, page) {
  return `<a class="lang-switch" href="../${page}" hreflang="en" lang="en" data-lang-switch title="${LANGUAGES[language].switchLabel}">EN</a>`
}

function build(html, page, language, lookup) {
  // First pass: every text, its placeholders back in place.
  const { units } = collect(html)
  let out = html
  for (const unit of [...units].reverse()) {
    const { text, tags } = sourceOf(unit, html)
    const translated = typeset(language, lookup(text))
    const restored = translated
      .replace(/<(\d+)\/>/g, (match, index) => tags[index]?.text ?? match)
      .replace(/<(\d+)>/g, (match, index) => tags[index]?.open ?? match)
      .replace(/<\/(\d+)>/g, (match, index) => tags[index]?.close ?? match)
      .replace(/\{([a-z][\w:-]*)\}/gi, (match, name) => tags.find((tag) => tag.kind === 'region' && tag.text.startsWith(`<!-- ${name} -->`))?.text ?? match)
    out = out.slice(0, unit.openEnd) + restored + out.slice(unit.closeStart)
  }
  // Second pass: every start tag, inside texts too.
  const second = parse(out)
  const edits = []
  const visit = (element) => {
    for (const child of element.children) {
      if (child.type !== 'element') continue
      if (hasAttr(child, 'data-lang-switch')) {
        edits.push({ start: child.start, end: child.end, text: languageSwitch(language, page) })
        continue
      }
      if (hasAttr(child, 'data-lang-menu')) {
        edits.push({ start: child.start, end: child.end, text: languageMenu(language, page, out.slice(child.start, child.openEnd)) })
        continue
      }
      const tag = out.slice(child.start, child.openEnd)
      const rewritten = rewriteTag(tag, out, { language, page, lookup })
      if (rewritten !== tag) edits.push({ start: child.start, end: child.openEnd, text: rewritten })
      if (child.name === 'script' && attr(child, 'type') === 'application/ld+json') {
        const raw = child.children[0]
        const data = JSON.parse(out.slice(raw.start, raw.end))
        data.description = lookup(data.description)
        data.url = pageUrl(page, language)
        data.inLanguage = language
        const indent = (out.slice(0, child.start).match(/[ \t]*$/) || [''])[0]
        edits.push({ start: raw.start, end: raw.end, text: `\n${indent}${JSON.stringify(data, null, 2).replace(/\n/g, `\n${indent}`)}\n${indent}` })
      }
      visit(child)
    }
  }
  visit(second)
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  // The notice follows the doctype: nothing but whitespace should come before it.
  return out.replace(/^(<!doctype html>\n?)/i, `$1<!-- Built by scripts/site-i18n.mjs from ../${page}: edit the English page and the catalog, not this file. -->\n`)
}

async function readCatalog(language) {
  const directory = new URL(`${language}/`, catalogs)
  const groups = {}
  let files = []
  try {
    files = await readdir(directory)
  } catch { /* A language without a catalog yet. */ }
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    groups[file.slice(0, -5)] = JSON.parse(await readFile(new URL(file, directory), 'utf8'))
  }
  return groups
}

async function writeCatalog(language, groups) {
  const directory = new URL(`${language}/`, catalogs)
  await mkdir(directory, { recursive: true })
  for (const [group, entries] of Object.entries(groups)) {
    await writeFile(new URL(`${group}.json`, directory), `${JSON.stringify(entries, null, 2)}\n`)
  }
}

const mode = process.argv.includes('--extract') ? 'extract' : process.argv.includes('--check') ? 'check' : 'build'
const lenient = process.argv.includes('--lenient')
const sources = Object.fromEntries(await Promise.all(PAGES.map(async (page) => [page, await readFile(new URL(page, site), 'utf8')])))
const textsByPage = Object.fromEntries(PAGES.map((page) => [page, collect(sources[page]).texts]))
let failed = false

for (const language of Object.keys(LANGUAGES)) {
  const groups = await readCatalog(language)
  if (mode === 'extract') {
    // A text used by several pages belongs to _shared; each other text to its page's file.
    const pagesOf = new Map()
    for (const page of PAGES) for (const text of textsByPage[page]) pagesOf.set(text, [...(pagesOf.get(text) || []), page])
    const known = Object.assign({}, ...Object.values(groups))
    const next = { _shared: {} }
    for (const page of PAGES) next[page.replace('.html', '')] = {}
    for (const [text, pages] of pagesOf) next[pages.length > 1 ? '_shared' : pages[0].replace('.html', '')][text] = known[text] ?? ''
    const unused = Object.keys(known).filter((text) => !pagesOf.has(text))
    await writeCatalog(language, next)
    const missing = [...pagesOf.keys()].filter((text) => !known[text]).length
    console.log(`${language}: ${pagesOf.size} texts, ${missing} to translate, ${unused.length} no longer used`)
    continue
  }
  const dictionary = Object.assign({}, ...Object.values(groups))
  const missing = new Set()
  const lookup = (text) => {
    const key = normalize(text)
    if (dictionary[key]) return dictionary[key]
    missing.add(key)
    return key
  }
  await mkdir(new URL(`${language}/`, site), { recursive: true })
  for (const page of PAGES) {
    const built = build(sources[page], page, language, lookup)
    const target = new URL(`${language}/${page}`, site)
    if (mode === 'check') {
      const current = await readFile(target, 'utf8').catch(() => '')
      // Generated regions are filled after this build; compare everything else.
      const strip = (html) => html.replace(/<!-- ([a-z][\w:-]*) -->[\s\S]*?<!-- \/\1 -->/gi, '<!-- $1 -->').replace(/(data-asset-size="[^"]*">)[^<]*/g, '$1')
      if (strip(current) !== strip(built)) {
        console.error(`${language}/${page} is out of date: run node scripts/site-i18n.mjs`)
        failed = true
      }
    } else {
      await writeFile(target, built)
    }
  }
  // The home page's currents name the catalog's features: fill them from this language's catalog.
  if (mode !== 'check') await fillCurrents(`${language}/`)
  if (missing.size) {
    const list = [...missing].slice(0, 12).map((text) => `  - ${text.slice(0, 120)}`).join('\n')
    console[lenient ? 'warn' : 'error'](`${language}: ${missing.size} text(s) without a translation${lenient ? ', kept in English' : ''}:\n${list}${missing.size > 12 ? '\n  …' : ''}\nRun node scripts/site-i18n.mjs --extract, then translate them in scripts/site-i18n/${language}/.`)
    if (!lenient) failed = true
  } else if (mode !== 'check') {
    console.log(`${language}: ${PAGES.length} pages built`)
  }
}
if (failed) process.exit(1)
