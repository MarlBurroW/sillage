#!/usr/bin/env node
/*
 * Fills the website's changelog from the GitHub releases, and the "latest release" mentions on
 * every page, in every language of the site (site/ in English, site/fr/ in French). The Pages
 * workflow runs it before each deployment, including when release notes are edited, so the site
 * follows the releases without a commit; the committed pages keep the last local run as a fallback.
 *
 *   node scripts/site-changelog.mjs                    # GitHub API (GH_TOKEN or GITHUB_TOKEN if set)
 *   node scripts/site-changelog.mjs --releases f.json  # a saved /releases response, offline
 *
 * Notes come from scripts/site-changelog/<lang>/<tag>.md when that file exists, otherwise from the
 * release on GitHub when it is written in that language. French pages fall back to the English
 * notes, marked as such, until a translation exists. No dependencies: the workflow runs it as is.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'

const repo = 'MarlBurroW/sillage'
const site = new URL('../site/', import.meta.url)
const notesRoot = new URL('./site-changelog/', import.meta.url)
// The newest releases read in full; older ones show their summary and fold the rest.
const OPEN_RELEASES = 3

const LANGUAGES = {
  en: {
    dir: '',
    locale: 'en-GB',
    latest: 'Latest',
    allNotes: (tag) => `All notes for ${tag}`,
    onGitHub: 'Release on GitHub',
    since: (tag) => `Changes since ${tag}`,
    count: (n) => `${n} ${n === 1 ? 'release' : 'releases'}`,
    badge: 'Latest release',
    stats: (n, first, tag, latest) => `${n} releases since ${first}. The latest, ${tag}, came out on ${latest}.`,
    noNotes: 'The notes for this release are on GitHub.',
  },
  fr: {
    dir: 'fr/',
    locale: 'fr-FR',
    latest: 'Dernière',
    allNotes: (tag) => `Toutes les notes de la ${tag}`,
    onGitHub: 'Publication sur GitHub',
    since: (tag) => `Changements depuis la ${tag}`,
    count: (n) => `${n} ${n === 1 ? 'version' : 'versions'}`,
    badge: 'Dernière version',
    stats: (n, first, tag, latest) => `${n} versions depuis le ${first}. La dernière, ${tag}, est sortie le ${latest}.`,
    noNotes: 'Les notes de cette version sont sur GitHub.',
    inEnglish: 'Notes en anglais',
  },
}

// The day stays with its month when a line wraps.
const dateFormat = (locale) => {
  const long = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (date) => long.format(new Date(date)).replace(' ', '\u00a0')
}
const monthFormat = (locale) => {
  const month = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  // A month that opens a heading or a link takes a capital, French included ("Novembre 2026").
  return (date) => month.format(new Date(date)).replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())
}

async function loadReleases() {
  const flag = process.argv.indexOf('--releases')
  if (flag !== -1) return JSON.parse(await readFile(process.argv[flag + 1], 'utf8'))
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'sillage-site-changelog' }
  if (token) headers.Authorization = `Bearer ${token}`
  const releases = []
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers })
    if (!response.ok) throw new Error(`GitHub releases API answered ${response.status}`)
    const batch = await response.json()
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
}

async function loadNotes(language) {
  const directory = new URL(`${language}/`, notesRoot)
  const notes = new Map()
  let files = []
  try {
    files = await readdir(directory)
  } catch { /* No written notes: every release is read as published. */ }
  for (const file of files) {
    if (file.endsWith('.md')) notes.set(file.slice(0, -3), await readFile(new URL(file, directory), 'utf8'))
  }
  return notes
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

function safeUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** Bare links read as what they point to: a pull request number, a compared range, an address. */
function linkLabel(href) {
  const github = href.match(/^https:\/\/github\.com\/MarlBurroW\/sillage\/(?:pull|issues)\/(\d+)/)
  if (github) return `#${github[1]}`
  const compare = href.match(/^https:\/\/github\.com\/MarlBurroW\/sillage\/compare\/(\S+)$/)
  if (compare) return compare[1]
  return href.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function link(href, label) {
  const url = safeUrl(href)
  return url ? `<a href="${escapeHtml(url)}">${label}</a>` : label
}

// The language of the notes being rendered: quotes and spacing follow it.
let textLanguage = 'en'

/** The site's typography: curly apostrophes and quotes in prose, French spacing in French. Code is never passed here. */
function smartQuotes(text) {
  const out = text
    .replace(/(\p{L})'(\p{L})/gu, '$1’$2')
    .replace(/(^|[\s(\[])'/gu, '$1‘')
    .replace(/'/g, '’')
  if (textLanguage !== 'fr') return out.replace(/(^|[\s(\[])"/gu, '$1“').replace(/"/g, '”')
  return out
    .replace(/(^|[\s(\[])"/gu, '$1« ')
    .replace(/"/g, ' »')
    .replace(/ ([;!?])/g, '\u202f$1')
    .replace(/ ([:»])/g, '\u00a0$1')
    .replace(/« /g, '«\u00a0')
}

/** Code spans, links, bare addresses, bold and italics. Everything else is text. */
function inline(source) {
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((\S+?)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"»])|\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])/
  let html = ''
  let rest = source
  while (rest) {
    const match = rest.match(pattern)
    if (!match) {
      html += escapeHtml(smartQuotes(rest))
      break
    }
    html += escapeHtml(smartQuotes(rest.slice(0, match.index)))
    const [, code, label, href, bare, bold, italic] = match
    if (code !== undefined) html += `<code>${escapeHtml(code)}</code>`
    else if (label !== undefined) html += link(href, inline(label))
    else if (bare !== undefined) html += link(bare, escapeHtml(linkLabel(bare)))
    else if (bold !== undefined) html += `<strong>${inline(bold)}</strong>`
    else html += `<em>${inline(italic)}</em>`
    rest = rest.slice(match.index + match[0].length)
  }
  return html
}

/** Strips what the page shows by itself: the compare link and GitHub's contributor list. */
function cleanNotes(markdown) {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^#{2,3}\s+New Contributors\s*\n(?:[*-].*\n?)*/gim, '')
    .replace(/^\s*\*\*\s*(?:full changelog|comparaison complète)\s*:?\s*\*\*\s*:?\s*\S*\s*$/gim, '')
    .trim()
}

/**
 * Release notes use a small part of Markdown: paragraphs, headings, bold lines as headings,
 * bullet lists (sometimes nested), quotes and inline marks. Section headings start at <h4>,
 * under the month (<h2>) and the version (<h3>).
 */
function parseBlocks(markdown) {
  const blocks = []
  const lines = cleanNotes(markdown).split('\n')
  let paragraph = []
  let quote = []
  let list = null
  let blankBefore = false

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'p', html: `<p>${inline(paragraph.join(' '))}</p>` })
    paragraph = []
  }
  const flushQuote = () => {
    if (quote.length) blocks.push({ type: 'quote', html: `<blockquote><p>${inline(quote.join(' '))}</p></blockquote>` })
    quote = []
  }
  const renderItems = (items) => `<ul>${items.map((item) => `<li>${inline(item.text)}${item.children.length ? renderItems(item.children) : ''}</li>`).join('')}</ul>`
  const flushList = () => {
    if (list) blocks.push({ type: 'ul', html: renderItems(list.root) })
    list = null
  }
  const flushAll = () => {
    flushParagraph()
    flushQuote()
    flushList()
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) {
      flushParagraph()
      flushQuote()
      blankBefore = true
      continue
    }
    const fence = line.match(/^\s*```/)
    if (fence) {
      flushAll()
      const code = []
      while (++index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index])
      blocks.push({ type: 'pre', html: `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>` })
      blankBefore = false
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    const boldHeading = line.match(/^\*\*([^*]+?)\*\*\s*:?\s*$/)
    if (heading || boldHeading) {
      flushAll()
      const level = heading ? Math.min(6, 4 + Math.max(0, heading[1].length - 2)) : 4
      blocks.push({ type: 'h', html: `<h${level}>${inline(heading ? heading[2] : boldHeading[1])}</h${level}>` })
      blankBefore = false
      continue
    }
    const item = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (item) {
      flushParagraph()
      flushQuote()
      const indent = item[1].replace(/\t/g, '  ').length
      if (!list) list = { root: [], stack: [] }
      // The stack holds the open lists from the outermost, each with the indentation of its items.
      while (list.stack.length && indent < list.stack[list.stack.length - 1].indent) list.stack.pop()
      const current = list.stack[list.stack.length - 1]
      const entry = { text: item[2], children: [] }
      if (!current) {
        list.root.push(entry)
        list.stack.push({ indent, items: list.root })
      } else if (indent > current.indent) {
        const parent = current.items[current.items.length - 1]
        parent.children.push(entry)
        list.stack.push({ indent, items: parent.children })
      } else current.items.push(entry)
      blankBefore = false
      continue
    }
    const quoted = line.match(/^>\s?(.*)$/)
    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      blankBefore = false
      continue
    }
    // An indented line, or one that directly follows an item, continues that item.
    if (list && (!blankBefore || /^\s{2,}/.test(line))) {
      const items = list.stack[list.stack.length - 1].items
      items[items.length - 1].text += ` ${line.trim()}`
      continue
    }
    flushList()
    flushQuote()
    paragraph.push(line.trim())
    blankBefore = false
  }
  flushAll()
  return blocks
}

function looksFrench(markdown) {
  const french = (markdown.match(/\b(les|des|une|est|pour|dans|avec|sont|sur|qui|aux|depuis|désormais)\b/gi) || []).length
  const english = (markdown.match(/\b(the|and|with|for|now|from|are|this|that|when|into|instead)\b/gi) || []).length
  return french > english
}

function releaseUrl(release) {
  const url = safeUrl(release.html_url || '')
  return url && url.startsWith(`https://github.com/${repo}/releases/`) ? url : `https://github.com/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}`
}

const indent = (html, depth) => html.split('\n').map((line) => (line ? ' '.repeat(depth) + line : line)).join('\n')

/** The notes a reader of this language gets, and the language they are written in. */
function notesFor(release, language, written) {
  const tag = release.tag_name
  const body = release.body ?? ''
  if (written[language].has(tag)) return { text: written[language].get(tag), language }
  if (language === 'fr' && looksFrench(body)) return { text: body, language: 'fr' }
  if (written.en.has(tag)) return { text: written.en.get(tag), language: 'en' }
  if (!looksFrench(body)) return { text: body, language: 'en' }
  console.warn(`${tag}: notes look French and have no English version in scripts/site-changelog/en/`)
  return { text: '', language: 'en' }
}

function renderRelease(release, previous, position, language, written) {
  const labels = LANGUAGES[language]
  const date = dateFormat(labels.locale)
  const tag = release.tag_name
  const id = escapeHtml(tag)
  const iso = release.published_at.slice(0, 10)
  const notes = notesFor(release, language, written)
  textLanguage = notes.language
  const blocks = parseBlocks(notes.text)
  const summary = blocks[0]?.type === 'p' ? blocks.shift() : null
  // Notes in another language than the page say so, to readers and to screen readers.
  const foreign = notes.language !== language
  const langAttribute = foreign ? ` lang="${notes.language}"` : ''
  const links = [`<a href="${escapeHtml(releaseUrl(release))}">${labels.onGitHub}</a>`]
  if (previous) links.push(`<a href="https://github.com/${repo}/compare/${encodeURIComponent(previous.tag_name)}...${encodeURIComponent(tag)}">${escapeHtml(labels.since(previous.tag_name))}</a>`)
  const badges = [
    position === 0 ? `<span class="release-latest">${labels.latest}</span>` : '',
    foreign && notes.text ? `<span class="release-language">${labels.inEnglish}</span>` : '',
  ].join('')
  const parts = [
    `<article class="release-entry" id="${id}" aria-labelledby="${id}-title">`,
    `  <header class="release-meta">`,
    `    <h3 id="${id}-title"><a href="#${id}">${escapeHtml(tag.replace(/^v/, 'Version '))}</a></h3>`,
    `    <time datetime="${iso}">${date(release.published_at)}</time>${badges}`,
    `  </header>`,
    `  <div class="release-body">`,
  ]
  if (summary) parts.push(`    ${summary.html.replace('<p>', `<p class="release-summary"${langAttribute}>`)}`)
  // Notes that open on a heading say what they cover through their section titles.
  const topics = summary ? [] : blocks
    .filter((block) => block.type === 'h')
    .map((block) => block.html.replace(/<[^>]+>/g, '').trim())
    .filter((title) => title && !/^(highlights|upgrade notes|what's changed|faits marquants|nouveautés|notes de mise à jour)$/i.test(title))
  if (topics.length) parts.push(`    <p class="release-topics"${langAttribute}>${topics.map((title) => `<span>${title}</span>`).join('')}</p>`)
  if (blocks.length) {
    const notesHtml = blocks.map((block) => block.html).join('\n')
    if (position < OPEN_RELEASES) parts.push(`    <div class="release-notes"${langAttribute}>\n${indent(notesHtml, 6)}\n    </div>`)
    else parts.push(`    <details class="release-more"><summary>${escapeHtml(labels.allNotes(tag))}</summary><div class="release-notes"${langAttribute}>\n${indent(notesHtml, 6)}\n    </div></details>`)
  } else if (!summary) parts.push(`    <p class="release-summary">${labels.noNotes}</p>`)
  parts.push(`    <p class="release-links">${links.join('')}</p>`, '  </div>', '</article>')
  textLanguage = 'en'
  return parts.join('\n')
}

function replaceBetween(html, name, content, file) {
  const start = `<!-- ${name} -->`
  const end = `<!-- /${name} -->`
  const from = html.indexOf(start)
  const to = html.indexOf(end)
  if (from === -1 || to < from) throw new Error(`${file}: missing ${start} … ${end}`)
  return html.slice(0, from + start.length) + content + html.slice(to)
}

const releases = (await loadReleases())
  .filter((release) => !release.draft && !release.prerelease && release.published_at)
  .sort((a, b) => b.published_at.localeCompare(a.published_at))
if (!releases.length) throw new Error('No published release')
const written = Object.fromEntries(await Promise.all(Object.keys(LANGUAGES).map(async (language) => [language, await loadNotes(language)])))
const latest = releases[0]
const first = releases[releases.length - 1]

// Package sizes as GitHub shows them (MiB, written MB in English, Mo in French); main.js refreshes them from the API.
const assetSize = (suffix, language) => {
  const asset = (latest.assets || []).find((candidate) => typeof candidate?.name === 'string' && candidate.name.endsWith(suffix))
  return asset?.size ? `${Math.round(asset.size / 1048576)} ${language === 'fr' ? 'Mo' : 'MB'}` : null
}

for (const [language, labels] of Object.entries(LANGUAGES)) {
  const date = dateFormat(labels.locale)
  const month = monthFormat(labels.locale)
  const months = []
  releases.forEach((release, position) => {
    const key = release.published_at.slice(0, 7)
    if (months[months.length - 1]?.key !== key) months.push({ key, label: month(release.published_at), entries: [] })
    months[months.length - 1].entries.push(renderRelease(release, releases[position + 1], position, language, written))
  })
  const list = months.map((group) => [
    `<section class="release-month" id="month-${group.key}" aria-labelledby="month-${group.key}-title">`,
    `  <h2 class="month-heading" id="month-${group.key}-title">${group.label} <span>${labels.count(group.entries.length)}</span></h2>`,
    indent(group.entries.join('\n'), 2),
    '</section>',
  ].join('\n')).join('\n')
  const time = (release) => `<time datetime="${release.published_at.slice(0, 10)}">${date(release.published_at)}</time>`
  const stats = labels.stats(releases.length, time(first), escapeHtml(latest.tag_name), time(latest))
  const jump = months.map((group) => `<a href="#month-${group.key}">${group.label}</a>`).join('')
  const latestMention = `<a href="changelog.html#${escapeHtml(latest.tag_name)}">${escapeHtml(latest.tag_name)}</a>, ${time(latest)}`
  // The footer's badge: a green dot, the version, its date; the whole of it leads to the notes.
  const releaseBadge = `<a class="release-badge" href="changelog.html#${escapeHtml(latest.tag_name)}"><span class="release-dot" aria-hidden="true"></span><span>${labels.badge}</span> <strong>${escapeHtml(latest.tag_name)}</strong><span class="release-sep" aria-hidden="true">·</span>${time(latest)}</a>`
  const directory = new URL(labels.dir, site)
  let files = []
  try {
    files = (await readdir(directory)).filter((name) => name.endsWith('.html'))
  } catch { /* This language's pages are not built yet. */ }
  for (const file of files) {
    const url = new URL(file, directory)
    const original = await readFile(url, 'utf8')
    let html = original
    if (file === 'changelog.html') {
      html = replaceBetween(html, 'changelog:stats', stats, file)
      html = replaceBetween(html, 'changelog:months', jump, file)
      html = replaceBetween(html, 'changelog:releases', `\n${indent(list, 8)}\n        `, file)
    }
    if (html.includes('<!-- latest-release -->')) html = html.replaceAll(/<!-- latest-release -->[\s\S]*?<!-- \/latest-release -->/g, `<!-- latest-release -->${latestMention}<!-- /latest-release -->`)
    html = html.replaceAll(/<!-- release-badge -->[\s\S]*?<!-- \/release-badge -->/g, `<!-- release-badge -->${releaseBadge}<!-- /release-badge -->`)
    html = html.replaceAll(/<!-- release-count -->[\s\S]*?<!-- \/release-count -->/g, `<!-- release-count -->${releases.length}<!-- /release-count -->`)
    html = html.replaceAll(/(<span data-asset-size="([^"]+)">)[^<]*(<\/span>)/g, (match, open, suffix, close) => {
      const size = assetSize(suffix, language)
      return size ? `${open}${size}${close}` : match
    })
    html = html.replace(/("softwareVersion": ")[^"]*(")/, `$1${latest.tag_name.replace(/^v/, '')}$2`)
    if (html !== original) {
      await writeFile(url, html)
      console.log(`Updated ${labels.dir}${file}`)
    }
  }
}
console.log(`${releases.length} releases, latest ${latest.tag_name}; notes written in ${Object.entries(written).map(([language, notes]) => `${language}: ${notes.size}`).join(', ')}`)
