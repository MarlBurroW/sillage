import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Exercise the deployed Pages prefix without touching the running application.
const site = fileURLToPath(new URL('../site/', import.meta.url))
const repository = fileURLToPath(new URL('../', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.mp4': 'video/mp4' }
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://test').pathname)
    const file = resolve(site, pathname.slice('/sillage/'.length) || 'index.html')
    if (!pathname.startsWith('/sillage/') || !file.startsWith(site.endsWith(sep) ? site : site + sep)) throw new Error('Outside site')
    // Read before answering: a missing file must still be able to answer 404.
    const body = await readFile(file)
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body)
  } catch {
    // Like GitHub Pages: any missing address under the site answers with its 404 page.
    const missing = await readFile(resolve(site, '404.html')).catch(() => 'Not found')
    response.writeHead(404, { 'Content-Type': 'text/html' }).end(missing)
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/sillage/`
const api = 'https://api.github.com/repos/MarlBurroW/sillage/releases/latest'
const releases = 'https://github.com/MarlBurroW/sillage/releases/'
const packages = ['win-x64.exe', 'mac-arm64.dmg', 'linux-amd64.deb', 'linux-arm64.deb', 'linux-x86_64.AppImage', 'linux-arm64.AppImage']
const release = { tag_name: 'v99.1.0', html_url: `${releases}tag/v99.1.0`, assets: packages.map((suffix) => ({ name: `Sillage-v99.1.0-${suffix}`, size: 99 * 1048576, browser_download_url: `${releases}download/v99.1.0/Sillage-v99.1.0-${suffix}` })) }
const pages = ['index.html', 'features.html', 'agents.html', 'download.html', 'docs.html', 'changelog.html', 'security.html']
const diagnostics = []
const assets = new Set()
const internalLinks = new Set()
const screenshots = process.env.SILLAGE_SITE_SHOTS
let browser

async function openPage(file = 'index.html', options = {}, { fallback = false, gate, missing = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...options })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copiedCommand = text } } })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => diagnostics.push(`${file}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (fallback && message.text().includes('net::ERR_FAILED')) return
    // The browser reports the 404 status of a missing page it was asked to open.
    if (missing && message.text().includes('status of 404')) return
    diagnostics.push(`${file}: ${message.text()}`)
  })
  page.on('requestfailed', (request) => {
    // A theme switch or a closing page cancels images still loading (net::ERR_ABORTED); every local
    // asset is fetched again at the end and must answer 200, so a missing file is still caught.
    if (request.url() !== api && request.failure()?.errorText !== 'net::ERR_ABORTED') diagnostics.push(`Request failed: ${request.url()}`)
  })
  await page.route(api, async (route) => {
    if (gate) await gate
    return fallback ? route.abort('failed') : route.fulfill({ json: release })
  })
  await page.goto(new URL(file, base).href)
  await page.evaluate(() => document.fonts.ready)
  return page
}

async function checkPage(page, file, width, colorScheme) {
  assert.equal(await page.locator('h1').count(), 1, `${file}: one main heading`)
  assert.ok((await page.locator('h1').textContent()).trim())
  assert.ok(await page.locator('meta[name="description"]').getAttribute('content'))
  assert.equal(await page.locator('html').getAttribute('data-theme'), colorScheme)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file}: horizontal overflow at ${width}px/${colorScheme}`)
  const problems = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id)
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index)
    const unnamed = [...document.querySelectorAll('button, input:not([type="hidden"]), select')].filter((element) => {
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false
      return !(element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.labels?.length || element.textContent.trim() || element.getAttribute('title'))
    }).map((element) => element.outerHTML)
    const unlabelledImages = [...document.querySelectorAll('img')].filter((element) => !element.hasAttribute('alt')).map((element) => element.src)
    return { duplicateIds, unnamed, unlabelledImages }
  })
  assert.deepEqual(problems, { duplicateIds: [], unnamed: [], unlabelledImages: [] }, `${file}: basic accessibility`)
  const menu = page.locator('[data-menu-toggle]')
  // The closed bar is one row: brand, language, theme and actions side by side.
  assert.ok((await page.locator('.topbar').boundingBox()).height < 72, `${file}: the top bar fits one row at ${width}px`)
  if (width <= 850) {
    assert.ok(await page.locator('#site-nav').isHidden())
    await menu.click()
    assert.ok(await page.locator('#site-nav').isVisible())
    await page.keyboard.press('Escape')
    assert.equal(await menu.getAttribute('aria-expanded'), 'false')
    assert.ok(await menu.evaluate((element) => element === document.activeElement))
  } else assert.ok(await menu.isHidden())
  if (screenshots && width !== 320) {
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: `${screenshots}/${file.replace('.html', '')}-${colorScheme}-${width}.png`, fullPage: true })
  }
}

async function checkTheme(page, file, theme) {
  const surfaces = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data]
    }
    const luminance = ([red, green, blue]) => [red, green, blue].map((channel) => {
      const value = channel / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    const selectors = 'body, .topbar, main > section, footer, [role="tabpanel"], .shot, .command, .rows, .facts, .catalog-sidebar, .catalog-search input, .edition-filter select, .package-group, table, dialog[open], .viewer-toolbar'
    return [...document.querySelectorAll(selectors)].filter((element) => element.getClientRects().length).map((element) => {
      const ancestors = []
      for (let current = element; current; current = current.parentElement) ancestors.unshift(current)
      const background = ancestors.reduce((result, current) => {
        const color = rgba(getComputedStyle(current).backgroundColor)
        const opacity = color[3] / 255
        return result.map((channel, index) => color[index] * opacity + channel * (1 - opacity))
      }, [255, 255, 255])
      return { label: element.id || element.className || element.tagName, brightness: luminance(background) }
    })
  })
  for (const surface of surfaces) {
    assert.ok(theme === 'light' ? surface.brightness > .5 : surface.brightness < .16,
      `${file}: ${surface.label} must follow ${theme} theme (background luminance ${surface.brightness.toFixed(3)})`)
  }
  assert.equal(await page.locator('[data-demo], [data-demo-task], [data-demo-step], [data-demo-next], [data-handoff-demo], [data-handoff-play]').count(), 0, `${file}: reconstructed product simulations have been removed`)
  await checkCaptureTheme(page, theme)
}

async function checkCaptureTheme(page, theme) {
  const images = page.locator('picture img[src*="screenshots/"]:visible')
  for (const image of await images.all()) {
    await image.evaluate(async (element) => { element.loading = 'eager'; await element.decode() })
    assert.ok((await image.evaluate((element) => element.currentSrc)).endsWith(`-${theme}.webp`), 'Real captures follow the selected theme')
  }
}

async function collectResources(page) {
  const references = await page.evaluate(() => ({
    assets: [...document.querySelectorAll('img, source, video, script[src], link[rel="stylesheet"], link[rel="preload"], link[rel="icon"], link[rel="apple-touch-icon"]')].flatMap((element) => ['src', 'srcset', 'poster', 'data-poster', 'href'].flatMap((attribute) => (element.getAttribute(attribute) || '').split(',').map((value) => value.trim().split(/\s+/)[0]).filter(Boolean))),
    links: [...document.querySelectorAll('a[href]')].map((element) => element.getAttribute('href')),
  }))
  for (const reference of references.assets) assets.add(new URL(reference, page.url()).href)
  for (const reference of references.links) {
    const url = new URL(reference, page.url())
    if (url.origin === new URL(base).origin) internalLinks.add(url.href)
  }
}

async function checkDownloads(page) {
  assert.equal(await page.locator('[data-asset]').count(), packages.length)
  for (const suffix of packages) {
    assert.equal(await page.locator(`[data-asset="${suffix}"]`).getAttribute('href'), `${releases}download/v99.1.0/Sillage-v99.1.0-${suffix}`)
    for (const size of await page.locator(`[data-asset-size="${suffix}"]`).all()) assert.equal(await size.textContent(), `99\u00a0${isFrench(page) ? 'Mo' : 'MB'}`, 'Package sizes follow the release')
  }
}

const releaseResolved = (page) => page.waitForFunction((href) => document.querySelector('[data-asset="win-x64.exe"]')?.href === href, `${releases}download/v99.1.0/Sillage-v99.1.0-win-x64.exe`)

async function checkTabs(page, firstId, lastId, nextId) {
  const first = page.locator(`#${firstId}`)
  await first.focus()
  const orientation = await first.locator('..').getAttribute('aria-orientation')
  await page.keyboard.press(orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight')
  assert.equal(await page.locator(`#${nextId}`).getAttribute('aria-selected'), 'true')
  await page.keyboard.press('End')
  assert.equal(await page.locator(`#${lastId}`).getAttribute('aria-selected'), 'true')
  await page.keyboard.press('Home')
  assert.equal(await first.getAttribute('aria-selected'), 'true')
}

// The folder of the page under test: '' for English, 'fr/' for French.
const folderOf = (page) => new URL(page.url()).pathname.replace('/sillage/', '').replace(/[^/]*$/, '')
const isFrench = (page) => folderOf(page) === 'fr/'

async function checkHome(page) {
  // The wake is decoration drawn from the theme tokens; under reduced motion it is one still frame.
  const wake = page.locator('canvas[data-wake]')
  assert.equal(await wake.getAttribute('data-wake-ready'), '')
  assert.equal(await wake.getAttribute('aria-hidden'), 'true')
  assert.ok(await wake.evaluate((canvas) => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    for (let index = 3; index < data.length; index += 4) if (data[index]) return true
    return false
  }), 'The wake draws its water')
  // The capabilities: illustrated tiles whose links lead to the catalog, and the catalog's names drifting above them.
  const tiles = page.locator('.bento .tile')
  assert.equal(await tiles.count(), 7, 'Six capabilities and the way to the catalog')
  assert.equal(await page.locator('.bento .tile-art svg').count(), 6, 'Each capability has its drawing')
  assert.equal(await page.locator('.tile-art [data-zoom], .tile-art img').count(), 0, 'The drawings are diagrams, not captures or interface mock-ups')
  const featureLinks = await page.locator('.tile-links a').evaluateAll((links) => links.map((link) => link.getAttribute('href')))
  assert.equal(new Set(featureLinks).size, featureLinks.length, 'Each tile link names a different feature')
  const catalog = await page.evaluate(async () => {
    const html = await (await fetch('features.html')).text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return [...doc.querySelectorAll('[data-feature] .feature-title')].map((title) => {
      const copy = title.cloneNode(true)
      copy.querySelectorAll('.edition-label').forEach((label) => label.remove())
      return copy.textContent.replace(/\s+/g, ' ').trim()
    })
  })
  const drifting = await page.locator('.current').evaluateAll((rows) => rows.map((row) => [...row.children].map((run) => [...run.children].map((name) => name.textContent.replace(/\s+/g, ' ').trim()))))
  for (const [first, second] of drifting) assert.deepEqual(first, second, 'Each current holds its names twice, for a seamless loop')
  assert.deepEqual(drifting.flatMap(([run]) => run).sort(), [...catalog].sort(), 'The currents name the features of the catalog: run node scripts/site-currents.mjs')
  // The closing tile counts what the tiles leave out, and names the catalog's size.
  const closing = await page.locator('.tile-catalog').textContent()
  assert.ok(closing.includes(String(catalog.length)), 'The closing tile names the number of features')
  assert.ok(closing.includes(String(catalog.length - featureLinks.length)), 'The closing tile counts the features the tiles do not name')
  // Off screen the drawings wait; each starts its story once in view, and the count runs up to the catalog's size.
  const lanes = page.locator('.tile-art').first()
  const playing = () => lanes.evaluate((art) => art.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length)
  if (!await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    await page.evaluate(() => scrollTo(0, 0))
    await page.waitForFunction(() => !document.querySelector('.tile-art').hasAttribute('data-running'))
    assert.equal(await playing(), 0, 'A drawing off screen waits')
    await lanes.scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('.tile-art').hasAttribute('data-running'))
    assert.ok(await playing() > 0, 'A drawing in view tells its story')
  }
  await page.locator('.tile-catalog').scrollIntoViewIfNeeded()
  await page.waitForFunction((total) => document.querySelector('.tile-figure span').textContent === total, String(catalog.length))
  await page.evaluate(() => scrollTo(0, 0))
  const selectedTheme = await page.locator('html').getAttribute('data-theme')
  for (const view of ['conversation', 'board', 'code', 'activity', 'usage']) {
    await page.locator(`#tab-${view}`).click()
    assert.ok(await page.locator(`#preview-${view}`).isVisible())
    await checkCaptureTheme(page, selectedTheme)
  }
  await checkTabs(page, 'tab-conversation', 'tab-usage', 'tab-board')
  const trigger = page.locator('#preview-conversation [data-zoom]')
  const dialog = page.locator('[data-zoom-dialog]')
  await trigger.locator('img').evaluate((image) => image.decode())
  const theme = await page.locator('html').getAttribute('data-theme')
  assert.ok((await trigger.locator('img').evaluate((image) => image.currentSrc)).endsWith(`-${theme}.webp`), 'Product captures follow the selected theme')
  await trigger.click()
  assert.ok(await dialog.isVisible())
  await checkTheme(page, 'index.html (capture viewer)', theme)
  await dialog.locator('[data-zoom-image]').evaluate((image) => image.decode())
  assert.equal(await dialog.locator('[data-zoom-image]').getAttribute('src'), await trigger.locator('img').evaluate((image) => image.currentSrc))
  assert.ok((await dialog.locator('[data-zoom-title]').textContent()).trim())
  await dialog.locator('[data-zoom-size]').click()
  assert.equal(await dialog.locator('[data-zoom-size]').getAttribute('aria-pressed'), 'true')
  await dialog.locator('.zoom-viewport').evaluate((element) => element.scrollTo(300, 300))
  await dialog.locator('[data-zoom-size]').click()
  assert.equal(await dialog.getAttribute('data-actual-size'), null)
  assert.equal(await dialog.locator('.zoom-viewport').evaluate((element) => element.scrollLeft + element.scrollTop), 0)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.ok(await trigger.evaluate((element) => element === document.activeElement), 'Zoom restores focus')
  await page.goto(`${base}${folderOf(page)}index.html#preview-usage`)
  assert.ok(await page.locator('#preview-usage').isVisible(), 'Screenshot deep links reveal the correct panel')
}

async function checkDownloadPage(page) {
  const folder = folderOf(page)
  await releaseResolved(page)
  await checkDownloads(page)
  assert.match(await page.locator('.page-intro-meta [href^="changelog.html#v"]').textContent(), /^v\d+\.\d+\.\d+$/, 'The download page names the latest release')
  assert.equal(await page.locator('[aria-labelledby$="-requirements-title"]').count(), 2, 'Both editions list their requirements')
  for (const platform of ['mac', 'windows', 'linux', 'all']) {
    await page.locator(`[data-platform="${platform}"]`).click()
    assert.equal(await page.locator(`[data-platform="${platform}"]`).getAttribute('aria-pressed'), 'true')
    for (const group of await page.locator('[data-platform-group]').all()) {
      assert.equal(await group.isVisible(), platform === 'all' || await group.getAttribute('data-platform-group') === platform)
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Platform filter ${platform} fits the page`)
  }
  await checkTabs(page, 'edition-desktop-tab', 'edition-server-tab', 'edition-server-tab')
  await page.locator('#edition-server-tab').click()
  assert.ok(await page.locator('#install-command').isVisible())
  await checkTheme(page, 'download.html (Server)', await page.locator('html').getAttribute('data-theme'))
  await page.locator('[data-copy]').click()
  assert.equal(await page.evaluate(() => window.copiedCommand), (await page.locator('#install-command').textContent()).trim())
  assert.match(await page.locator('#copy-status').textContent(), /cop(ied|iée)/i)
  await page.goto(`${base}${folder}download.html#install`)
  assert.ok(await page.locator('#install-command').isVisible(), 'Server deep link selects Server')
}

async function checkAgents(page) {
  const folder = folderOf(page)
  await checkTabs(page, 'agent-tab-claude', 'agent-tab-copilot', 'agent-tab-codex')
  for (const agent of ['claude', 'codex', 'opencode', 'grok', 'antigravity', 'copilot']) {
    await page.locator(`#agent-tab-${agent}`).click()
    assert.ok(await page.locator(`#agent-${agent}`).isVisible())
    await checkTheme(page, `agents.html (${agent})`, await page.locator('html').getAttribute('data-theme'))
  }
  await page.goto(`${base}${folder}agents.html#agent-opencode`)
  assert.ok(await page.locator('#agent-opencode').isVisible(), 'Agent deep links reveal their panel')
}

async function checkCatalog(page) {
  const folder = folderOf(page)
  const term = (await page.locator('#checkpoints .feature-title').textContent()).split(/\s+/).sort((a, b) => b.length - a.length)[0].toLowerCase()
  const all = await page.locator('[data-feature]').count()
  assert.ok(all >= 50, 'The full catalog contains the documented feature inventory')
  assert.equal(await page.locator('[data-feature]:visible').count(), all)
  await page.locator('#feature-search').fill(term)
  assert.ok(await page.locator('#checkpoints').isVisible())
  assert.equal(await page.locator('#checkpoints').getAttribute('open'), '')
  assert.ok(await page.locator('[data-feature]:visible').count() < all)
  assert.equal(new URL(page.url()).searchParams.get('q'), term)
  await page.locator('[data-clear-search]').click()
  assert.equal(await page.locator('[data-feature]:visible').count(), all)
  await page.locator('#feature-edition').selectOption('desktop')
  assert.equal(await page.locator('[data-feature][data-editions="server"]:visible').count(), 0)
  await page.locator('.catalog-sidebar [data-category="automation"]').click()
  assert.equal(new URL(page.url()).hash, '#automation')
  assert.equal(await page.locator('[data-feature-category]:visible').count(), 1)
  await page.goBack()
  assert.equal(await page.locator('#feature-edition').inputValue(), 'desktop')
  assert.ok(await page.locator('[data-feature-category]:visible').count() > 1, 'Back restores the previous catalog category')
  await page.locator('#feature-search').fill('there is no such feature 98347')
  assert.ok(await page.locator('[data-catalog-empty]').isVisible())
  assert.equal(await page.locator('[data-feature]:visible').count(), 0)
  await page.locator('[data-catalog-empty] [data-reset-filters]').click()
  assert.equal(await page.locator('[data-feature]:visible').count(), all)
  assert.equal(await page.locator('#feature-edition').inputValue(), 'all')
  await page.goto(`${base}${folder}features.html?q=no-match&edition=server#checkpoints`)
  assert.ok(await page.locator('#checkpoints').isVisible())
  assert.equal(await page.locator('#checkpoints').getAttribute('open'), '')
  assert.equal(await page.locator('#feature-search').inputValue(), '')
  assert.equal(await page.locator('#feature-edition').inputValue(), 'all', 'Permanent feature links override incompatible filters')
}

async function checkChangelog(page) {
  const folder = folderOf(page)
  const entries = page.locator('.release-entry')
  assert.ok(await entries.count() >= 40, 'The changelog lists the releases')
  assert.equal(await page.locator('.release-latest').count(), 1)
  assert.equal(await entries.first().locator('.release-latest').count(), 1, 'The newest release comes first')
  for (const id of await entries.evaluateAll((items) => items.map((item) => item.id))) assert.match(id, /^v\d+\.\d+\.\d+$/)
  for (const href of await page.locator('.changelog-jump a').evaluateAll((links) => links.map((link) => link.getAttribute('href')))) {
    assert.equal(await page.locator(href.replace(/^#/, '[id="') + '"]').count(), 1, `Month link ${href} has a target`)
  }
  const folded = page.locator('.release-more').first()
  assert.equal(await folded.getAttribute('open'), null)
  await folded.locator('summary').click()
  assert.equal(await folded.getAttribute('open'), '')
  assert.ok(await folded.locator('.release-notes').isVisible())
  const text = await page.locator('.changelog-list').textContent()
  if (isFrench(page)) {
    assert.match(await page.locator('.changelog-stats').textContent(), /^\d+ versions depuis le /)
    assert.equal(await page.locator('.release-language').count(), 0, 'Every release has French notes')
  } else {
    assert.doesNotMatch(text, /\b(Nouveautés|désormais|Comparaison complète|What's Changed)\b/, 'Notes first published in French read in English')
    assert.match(await page.locator('.changelog-stats').textContent(), /^\d+ releases since /)
  }
  // Search: "/" focuses the field; a word keeps the releases that mention it, in the URL too.
  const total = await entries.count()
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('/')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'release-search')
  await page.keyboard.type('copilot')
  const kept = await page.locator('.release-entry:visible').count()
  assert.ok(kept > 0 && kept < total, `The changelog search keeps the releases that mention a word (${kept} of ${total})`)
  for (const entry of await page.locator('.release-entry:visible').all()) assert.match(await entry.textContent(), /copilot/i)
  assert.equal(new URL(page.url()).searchParams.get('q'), 'copilot')
  await page.keyboard.type(' zzqxw')
  assert.ok(await page.locator('[data-changelog-empty]').isVisible(), 'A search without result says so')
  await page.locator('[data-changelog-empty] [data-reset-search]').click()
  assert.equal(await page.locator('.release-entry:visible').count(), total)
  await page.goto(`${base}${folder}changelog.html?q=copilot`)
  assert.equal(await page.locator('.release-entry:visible').count(), kept, 'A search link opens filtered')
  await page.goto(`${base}${folder}changelog.html#v0.40.0`)
  assert.ok(await page.locator('[id="v0.40.0"]').isVisible(), 'Release links reach their entry')
}

async function checkDocs(page) {
  assert.equal(await page.locator('#start .steps li').count(), 6)
  const guides = await page.locator('.guide').evaluateAll((links) => links.map((link) => link.href))
  assert.ok(guides.length >= 12, 'The documentation lists the guides')
  for (const href of guides) assert.ok(href.startsWith('https://github.com/MarlBurroW/sillage/blob/main/'), `Guides open in the repository: ${href}`)
}

async function checkSecurity(page) {
  for (const id of ['stays', 'leaves', 'access', 'agents', 'updates', 'report']) assert.equal(await page.locator(`[id="${id}"]`).count(), 1, `security.html#${id}`)
}

// Repository links must name a file that exists, and a heading when they carry an anchor.
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
function checkRepositoryLink(href) {
  const match = href.match(/^https:\/\/github\.com\/MarlBurroW\/sillage\/(?:blob|tree)\/main\/([^#?]+)(?:#(.+))?$/)
  if (!match) return
  const path = resolve(repository, decodeURIComponent(match[1]))
  assert.ok(existsSync(path), `Repository link to a missing file: ${href}`)
  if (!match[2] || !path.endsWith('.md')) return
  const anchors = readFileSync(path, 'utf8').split('\n').filter((line) => /^#{1,6}\s/.test(line)).map((line) => slug(line.replace(/^#+\s*/, '')))
  assert.ok(anchors.includes(decodeURIComponent(match[2])), `Repository link to a missing heading: ${href}`)
}

async function checkLanguage(page, file, french) {
  const lang = await page.locator('html').getAttribute('lang')
  assert.equal(lang, french ? 'fr' : 'en', `${file}: page language`)
  if (file === '404.html') return
  const name = file === 'index.html' ? '' : file
  const toggle = page.locator('[data-lang-switch]')
  assert.equal(await toggle.getAttribute('href'), french ? `../${file}` : `fr/${file}`, `${file}: language switch`)
  assert.equal(await toggle.getAttribute('hreflang'), french ? 'en' : 'fr')
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), `https://marlburrow.github.io/sillage/${french ? 'fr/' : ''}${name}`)
  for (const [hreflang, prefix] of [['en', ''], ['fr', 'fr/'], ['x-default', '']]) {
    assert.equal(await page.locator(`link[rel="alternate"][hreflang="${hreflang}"]`).getAttribute('href'), `https://marlburrow.github.io/sillage/${prefix}${name}`, `${file}: ${hreflang} alternate`)
  }
}

try {
  // The French pages must be built from the current English ones, with every text translated.
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('./site-i18n.mjs', import.meta.url)), '--check'], { stdio: 'pipe' })
  } catch (error) {
    throw new Error(`site/fr is out of date or incomplete:\n${error.stdout}${error.stderr}`)
  }
  console.log('PASS French pages built from the English ones, every text translated')
  browser = await chromium.launch({ chromiumSandbox: true })
  for (const file of pages) {
    for (const width of [1440, 390, 320]) for (const colorScheme of ['light', 'dark']) {
      const page = await openPage(file, { viewport: { width, height: 1000 }, colorScheme })
      await checkPage(page, file, width, colorScheme)
      await checkTheme(page, file, colorScheme)
      if (width === 1440 && colorScheme === 'light') await collectResources(page)
      await page.locator('[data-theme-toggle]').click()
      const switchedTheme = colorScheme === 'light' ? 'dark' : 'light'
      assert.equal(await page.locator('html').getAttribute('data-theme'), switchedTheme)
      await checkTheme(page, file, switchedTheme)
      if (file === 'index.html') await checkHome(page)
      if (file === 'download.html') await checkDownloadPage(page)
      if (file === 'agents.html') await checkAgents(page)
      if (file === 'features.html') await checkCatalog(page)
      if (file === 'changelog.html') await checkChangelog(page)
      if (file === 'docs.html') await checkDocs(page)
      if (file === 'security.html') await checkSecurity(page)
      if (width === 1440 && colorScheme === 'light') await checkLanguage(page, file, false)
      console.log(`PASS ${file} ${width}px ${colorScheme}: layout, accessible controls, navigation, theme, interactions`)
      await page.context().close()
    }
  }

  for (const file of pages) {
    for (const width of [1440, 390]) for (const colorScheme of ['light', 'dark']) {
      const french = `fr/${file}`
      const page = await openPage(french, { viewport: { width, height: 1000 }, colorScheme })
      await checkPage(page, french, width, colorScheme)
      await checkTheme(page, french, colorScheme)
      await checkLanguage(page, file, true)
      if (width === 1440 && colorScheme === 'light') await collectResources(page)
      if (file === 'index.html') await checkHome(page)
      if (file === 'download.html') await checkDownloadPage(page)
      if (file === 'agents.html') await checkAgents(page)
      if (file === 'features.html') await checkCatalog(page)
      if (file === 'changelog.html') await checkChangelog(page)
      if (file === 'docs.html') await checkDocs(page)
      if (file === 'security.html') await checkSecurity(page)
      console.log(`PASS ${french} ${width}px ${colorScheme}: layout, language, theme, interactions`)
      await page.context().close()
    }
  }

  // The switch leads to the same page in the other language, and back.
  const switching = await openPage('download.html', { viewport: { width: 1440, height: 1000 } })
  await switching.locator('[data-lang-switch]').click()
  await switching.waitForURL('**/fr/download.html')
  assert.equal(await switching.locator('html').getAttribute('lang'), 'fr')
  await switching.locator('[data-lang-switch]').click()
  await switching.waitForURL('**/sillage/download.html')
  assert.equal(await switching.locator('html').getAttribute('lang'), 'en')
  await switching.context().close()
  console.log('PASS language switch to the same page and back')

  const navigation = await openPage('index.html', { viewport: { width: 390, height: 844 }, colorScheme: 'light' })
  await navigation.locator('[data-theme-toggle]').click()
  for (const file of ['features.html', 'agents.html', 'docs.html', 'changelog.html', 'download.html']) {
    await navigation.locator('[data-menu-toggle]').click()
    await navigation.locator(`#site-nav a[href="${file}"]`).click()
    // The menu folds once the new page's script has run.
    await navigation.waitForURL(`**/${file}`)
    await navigation.locator('.topbar[data-enhanced]').waitFor({ state: 'attached' })
    assert.equal(await navigation.locator('html').getAttribute('data-theme'), 'dark', 'Theme persists between pages')
    assert.ok(await navigation.locator('#site-nav').isHidden())
    assert.equal(await navigation.locator('#site-nav [aria-current="page"]').getAttribute('href'), file)
  }
  await navigation.locator('.topbar .brand').click()
  await navigation.waitForURL('**/index.html')
  assert.equal(new URL(navigation.url()).pathname, '/sillage/index.html')
  assert.equal(await navigation.locator('#site-nav [aria-current="page"]').count(), 0)
  await navigation.locator('[data-menu-toggle]').click()
  await navigation.setViewportSize({ width: 1440, height: 1000 })
  await navigation.waitForFunction(() => document.querySelector('[data-menu-toggle]').getAttribute('aria-expanded') === 'false')
  assert.ok((await navigation.locator('.topbar').boundingBox()).height < 100)
  await navigation.context().close()
  console.log('PASS cross-page mobile navigation, theme persistence and desktop menu reset')

  // Between the phone and desktop layouts the gallery stacks: the film link follows the capture.
  for (const width of [768, 600]) {
    const tablet = await openPage('index.html', { viewport: { width, height: 1000 } })
    const capture = await tablet.locator('#preview-conversation').boundingBox()
    const film = await tablet.locator('.gallery .film-link').boundingBox()
    assert.ok(film.y > capture.y + capture.height - 1, `Film link under the capture at ${width}px`)
    assert.ok(await tablet.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `index.html fits at ${width}px`)
    await tablet.context().close()
  }
  console.log('PASS gallery order at tablet widths')

  // Phone widths between the test matrix's sizes, where longer French labels wrap first.
  for (const file of ['download.html', 'fr/download.html']) for (const width of [360, 414, 480, 600, 768, 851, 960]) {
    const narrow = await openPage(file, { viewport: { width, height: 800 } })
    assert.ok((await narrow.locator('.topbar').boundingBox()).height < 72, `${file}: the top bar fits one row at ${width}px`)
    assert.ok(await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file}: fits at ${width}px`)
    await narrow.context().close()
  }
  console.log('PASS one-row top bar in both languages from 360 to 960px')

  for (const width of [1440, 390]) {
    const page = await openPage('index.html', { viewport: { width, height: 1000 } })
    const dialog = page.locator('[data-film-dialog]')
    await page.locator('a[data-film-open]').first().click()
    await dialog.waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('[data-film]').paused)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.querySelector('[data-film]').paused)
    await page.goto(`${base}index.html#film`)
    await dialog.waitFor({ state: 'visible' })
    assert.ok(await page.locator('[data-film]').evaluate((video) => video.paused), 'Film deep links do not autoplay')
    await dialog.locator('[data-dialog-close]').click()
    await page.evaluate(() => { location.hash = '#top' })
    await page.evaluate(() => { location.hash = '#film' })
    await dialog.waitFor({ state: 'visible' })
    assert.ok(await page.locator('[data-film]').evaluate((video) => video.paused))
    await page.context().close()
  }
  console.log('PASS film playback, close pauses, and direct links without autoplay')

  const animated = await openPage('index.html', { reducedMotion: 'no-preference' })
  // Time-based animations only: scroll-driven ones follow the reader and never finish on their own.
  await animated.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.timeline === document.timeline && animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))))
  assert.equal(await animated.locator('h1').evaluate((element) => getComputedStyle(element).opacity), '1', 'The headline is fully visible after its entrance')
  assert.equal(await animated.locator('.gallery').evaluate((element) => getComputedStyle(element).opacity), '1', 'Real captures are fully visible')
  // With motion allowed, an unattended pass crosses the hero and stirs rows into the wake colour.
  await animated.waitForFunction(() => {
    const canvas = document.querySelector('canvas[data-wake]')
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 120 && data[index + 2] > data[index] + 60) return true
    return false
  })
  await checkHome(animated)
  await animated.goto(`${base}agents.html`)
  await checkAgents(animated)
  await animated.context().close()
  console.log('PASS real screenshot navigation and agent panels with standard motion preferences')

  let releaseReady
  const delayed = await openPage('download.html', {}, { gate: new Promise((resolve) => { releaseReady = resolve }) })
  assert.equal(await delayed.locator('[data-asset="win-x64.exe"]').getAttribute('href'), `${releases}latest/download/Sillage-win-x64.exe`)
  releaseReady()
  await releaseResolved(delayed)
  await checkDownloads(delayed)
  await delayed.context().close()
  const fallback = await openPage('download.html', {}, { fallback: true })
  for (const suffix of packages) {
    assert.equal(await fallback.locator(`[data-asset="${suffix}"]`).getAttribute('href'), `${releases}latest/download/Sillage-${suffix}`)
    assert.match(await fallback.locator(`[data-asset-size="${suffix}"]`).textContent(), /^\d+\u00a0MB$/, 'Without the API, the sizes written at deployment remain')
  }
  await fallback.context().close()
  console.log('PASS release resolution, delayed API response and offline release fallback')

  for (const file of pages) for (const colorScheme of ['light', 'dark']) {
    const page = await openPage(file, { javaScriptEnabled: false, colorScheme, viewport: { width: 390, height: 844 } })
    await checkTheme(page, `${file} (no JavaScript)`, colorScheme)
    assert.ok(await page.locator('#site-nav').isVisible())
    assert.ok(await page.locator('[data-menu-toggle]').isHidden())
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file}: no-JavaScript layout fits the viewport`)
    for (const panel of await page.getByRole('tabpanel').all()) assert.ok(await panel.isVisible(), `${file}: all panels remain readable without JavaScript`)
    if (file === 'index.html') {
      assert.ok(await page.locator('#film [data-film]').isVisible())
      assert.equal(await page.locator('[data-film]').getAttribute('controls'), '')
      assert.equal(await page.locator('canvas[data-wake]').getAttribute('data-wake-ready'), null)
    }
    if (file === 'download.html') {
      assert.ok(await page.locator('#install-command').isVisible())
      for (const suffix of packages) assert.ok(await page.locator(`[data-asset="${suffix}"]`).isVisible())
      assert.ok(await page.locator('[data-platform-filter]').isHidden())
    }
    if (file === 'features.html') {
      assert.equal(await page.locator('[data-feature]:visible').count(), await page.locator('[data-feature]').count())
      assert.ok(await page.locator('[data-catalog-controls]').isHidden())
      await page.locator('#checkpoints summary').click()
      assert.equal(await page.locator('#checkpoints').getAttribute('open'), '')
    }
    await page.context().close()
  }
  for (const file of pages) {
    const page = await openPage(`fr/${file}`, { javaScriptEnabled: false, colorScheme: 'light', viewport: { width: 390, height: 844 } })
    await checkTheme(page, `fr/${file} (no JavaScript)`, 'light')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `fr/${file}: no-JavaScript layout fits the viewport`)
    await page.context().close()
  }
  console.log(`PASS all ${pages.length} pages without JavaScript in both themes, and in French, including captures, features and package links`)

  // Scripts allowed but main.js unreachable: the page takes back its "js" class and reads like the no-script one.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.route('**/main.js*', (route) => route.abort('failed'))
    await page.route(api, (route) => route.abort('failed'))
    await page.goto(new URL('download.html', base).href)
    await page.waitForFunction(() => !document.documentElement.classList.contains('js'))
    assert.ok(await page.locator('#site-nav').isVisible(), 'Without main.js the navigation stays in view')
    for (const panel of await page.getByRole('tabpanel').all()) assert.ok(await panel.isVisible(), 'Without main.js every panel is listed')
    assert.ok(await page.locator('.editions > .tabs').isHidden(), 'Without main.js the tab strip is not offered')
    await context.close()
    console.log('PASS fallback to the no-script layout when main.js cannot load')
  }

  // With scripts, the first paint already has one panel per tab group and the folded menu: nothing jumps.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.addInitScript(() => {
      window.layoutShift = 0
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.layoutShift += entry.value }).observe({ type: 'layout-shift', buffered: true })
    })
    await page.route(api, (route) => route.fulfill({ json: release }))
    for (const file of ['index.html', 'download.html', 'features.html']) {
      await page.goto(new URL(file, base).href)
      await page.waitForLoadState('load')
      await page.waitForTimeout(400)
      const shift = await page.evaluate(() => window.layoutShift)
      assert.ok(shift < 0.02, `${file}: the page does not jump while it loads (layout shift ${shift.toFixed(3)})`)
    }
    await context.close()
    console.log('PASS no layout shift while the home, download and feature pages load')
  }

  // A missing address answers with the site's own 404 page, styled and with working links.
  for (const colorScheme of ['light', 'dark']) {
    const missing = await openPage('some/old/address.html', { colorScheme, viewport: { width: 390, height: 844 } }, { missing: true })
    assert.match(await missing.locator('h1').textContent(), /not found/i)
    await checkTheme(missing, '404.html', colorScheme)
    assert.equal(await missing.locator('.not-found-links a').count(), 4)
    await missing.locator('.not-found-links a[href="features.html"]').click()
    assert.equal(new URL(missing.url()).pathname, '/sillage/features.html', 'Links on the 404 page start from the site')
    await missing.context().close()
  }
  console.log('PASS custom 404 page at any depth, in both themes')

  const missingFrench = await openPage('fr/une/vieille/adresse.html', { viewport: { width: 390, height: 844 } }, { missing: true })
  await missingFrench.waitForURL('**/sillage/fr/404.html')
  assert.equal(await missingFrench.locator('html').getAttribute('lang'), 'fr', 'A missing French address shows the French 404 page')
  assert.equal(await missingFrench.locator('.not-found-links a').count(), 4)
  await missingFrench.locator('.not-found-links a[href="features.html"]').click()
  assert.equal(new URL(missingFrench.url()).pathname, '/sillage/fr/features.html', 'Links on the French 404 page stay in French')
  await missingFrench.context().close()
  console.log('PASS French 404 page for missing French addresses')

  for (const asset of [...assets]) {
    const url = new URL(asset)
    if (url.origin !== new URL(base).origin) continue
    assert.ok(url.pathname.startsWith('/sillage/'), `Asset escapes the Pages prefix: ${asset}`)
    const response = await fetch(url)
    assert.equal(response.status, 200, `Missing asset: ${asset}`)
    if (url.pathname.endsWith('.css')) {
      for (const match of (await response.text()).matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
        const reference = new URL(match[1], url)
        if (reference.origin === new URL(base).origin) {
          assert.ok(reference.pathname.startsWith('/sillage/'))
          assert.equal((await fetch(reference)).status, 200, `Missing CSS asset: ${reference}`)
        }
      }
    }
  }
  for (const link of internalLinks) {
    const url = new URL(link)
    assert.ok(url.pathname.startsWith('/sillage/'), `Link escapes the Pages prefix: ${link}`)
    const response = await fetch(url)
    assert.equal(response.status, 200, `Broken internal link: ${link}`)
    if (url.hash && url.hash !== '#') {
      const html = await response.text()
      const id = decodeURIComponent(url.hash.slice(1))
      assert.ok(html.includes(`id="${id}"`) || html.includes(`id='${id}'`), `Missing link target: ${link}`)
    }
  }
  const repositoryLinks = new Set()
  for (const file of [...pages, ...pages.map((page) => `fr/${page}`)]) {
    for (const match of (await readFile(resolve(site, file), 'utf8')).matchAll(/href="(https:\/\/github\.com\/MarlBurroW\/sillage\/(?:blob|tree)\/main\/[^"]+)"/g)) repositoryLinks.add(match[1].replaceAll('&amp;', '&'))
  }
  for (const href of repositoryLinks) checkRepositoryLink(href)
  console.log(`PASS ${repositoryLinks.size} links into the repository name existing files and headings`)
  assert.deepEqual(diagnostics, [], 'Unexpected browser errors')
  console.log(`PASS ${internalLinks.size} internal links and all local images, fonts, styles and scripts under /sillage/`)
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
}
