import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Exercise the deployed Pages prefix without touching the running application.
const site = fileURLToPath(new URL('../site/', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.mp4': 'video/mp4' }
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://test').pathname)
    const file = resolve(site, pathname.slice('/sillage/'.length) || 'index.html')
    if (!pathname.startsWith('/sillage/') || !file.startsWith(site.endsWith(sep) ? site : site + sep)) throw new Error('Outside site')
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(await readFile(file))
  } catch {
    response.writeHead(404).end('Not found')
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/sillage/`
const api = 'https://api.github.com/repos/MarlBurroW/sillage/releases/latest'
const releases = 'https://github.com/MarlBurroW/sillage/releases/'
const packages = ['win-x64.exe', 'mac-arm64.dmg', 'linux-amd64.deb', 'linux-arm64.deb', 'linux-x86_64.AppImage', 'linux-arm64.AppImage']
const release = { tag_name: 'v99.1.0', html_url: `${releases}tag/v99.1.0`, assets: packages.map((suffix) => ({ name: `Sillage-v99.1.0-${suffix}`, browser_download_url: `${releases}download/v99.1.0/Sillage-v99.1.0-${suffix}` })) }
const pages = ['index.html', 'features.html', 'agents.html', 'download.html']
const diagnostics = []
const assets = new Set()
const internalLinks = new Set()
const screenshots = process.env.SILLAGE_SITE_SHOTS
let browser

async function openPage(file = 'index.html', options = {}, { fallback = false, gate } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...options })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copiedCommand = text } } })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => diagnostics.push(`${file}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !(fallback && message.text().includes('net::ERR_FAILED'))) diagnostics.push(`${file}: ${message.text()}`)
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
    assets: [...document.querySelectorAll('img, source, video, script[src], link[rel="stylesheet"], link[rel="preload"], link[rel="icon"]')].flatMap((element) => ['src', 'srcset', 'poster', 'href'].flatMap((attribute) => (element.getAttribute(attribute) || '').split(',').map((value) => value.trim().split(/\s+/)[0]).filter(Boolean))),
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
  }
}

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
  assert.equal(await page.locator('.story .shot img').count(), 5, 'Each story shows a real capture')
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
  await page.goto(`${base}index.html#preview-usage`)
  assert.ok(await page.locator('#preview-usage').isVisible(), 'Screenshot deep links reveal the correct panel')
}

async function checkDownloadPage(page) {
  await page.locator('#version-badge').filter({ hasText: 'v99.1.0' }).waitFor()
  await checkDownloads(page)
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
  assert.match(await page.locator('#copy-status').textContent(), /copied/i)
  await page.goto(`${base}download.html#install`)
  assert.ok(await page.locator('#install-command').isVisible(), 'Server deep link selects Server')
}

async function checkAgents(page) {
  await checkTabs(page, 'agent-tab-claude', 'agent-tab-copilot', 'agent-tab-codex')
  for (const agent of ['claude', 'codex', 'opencode', 'grok', 'antigravity', 'copilot']) {
    await page.locator(`#agent-tab-${agent}`).click()
    assert.ok(await page.locator(`#agent-${agent}`).isVisible())
    await checkTheme(page, `agents.html (${agent})`, await page.locator('html').getAttribute('data-theme'))
  }
  await page.goto(`${base}agents.html#agent-opencode`)
  assert.ok(await page.locator('#agent-opencode').isVisible(), 'Agent deep links reveal their panel')
}

async function checkCatalog(page) {
  const all = await page.locator('[data-feature]').count()
  assert.ok(all >= 50, 'The full catalog contains the documented feature inventory')
  assert.equal(await page.locator('[data-feature]:visible').count(), all)
  await page.locator('#feature-search').fill('checkpoint')
  assert.ok(await page.locator('#checkpoints').isVisible())
  assert.equal(await page.locator('#checkpoints').getAttribute('open'), '')
  assert.ok(await page.locator('[data-feature]:visible').count() < all)
  assert.equal(new URL(page.url()).searchParams.get('q'), 'checkpoint')
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
  await page.goto(`${base}features.html?q=no-match&edition=server#checkpoints`)
  assert.ok(await page.locator('#checkpoints').isVisible())
  assert.equal(await page.locator('#checkpoints').getAttribute('open'), '')
  assert.equal(await page.locator('#feature-search').inputValue(), '')
  assert.equal(await page.locator('#feature-edition').inputValue(), 'all', 'Permanent feature links override incompatible filters')
}

try {
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
      console.log(`PASS ${file} ${width}px ${colorScheme}: layout, accessible controls, navigation, theme, interactions`)
      await page.context().close()
    }
  }

  const navigation = await openPage('index.html', { viewport: { width: 390, height: 844 }, colorScheme: 'light' })
  await navigation.locator('[data-theme-toggle]').click()
  for (const file of ['features.html', 'agents.html', 'index.html']) {
    await navigation.locator('[data-menu-toggle]').click()
    await navigation.locator(`#site-nav a[href="${file}"]`).click()
    assert.equal(await navigation.locator('html').getAttribute('data-theme'), 'dark', 'Theme persists between pages')
    assert.ok(await navigation.locator('#site-nav').isHidden())
    assert.equal(await navigation.locator('#site-nav [aria-current="page"]').getAttribute('href'), file)
  }
  await navigation.locator('[data-menu-toggle]').click()
  await navigation.setViewportSize({ width: 1440, height: 1000 })
  await navigation.waitForFunction(() => document.querySelector('[data-menu-toggle]').getAttribute('aria-expanded') === 'false')
  assert.ok((await navigation.locator('.topbar').boundingBox()).height < 100)
  await navigation.context().close()
  console.log('PASS cross-page mobile navigation, theme persistence and desktop menu reset')

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
  await animated.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))))
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
  await delayed.locator('#version-badge').filter({ hasText: 'v99.1.0' }).waitFor()
  await checkDownloads(delayed)
  await delayed.context().close()
  const fallback = await openPage('download.html', {}, { fallback: true })
  assert.equal(await fallback.locator('#version-badge').getAttribute('href'), `${releases}latest`)
  for (const suffix of packages) assert.equal(await fallback.locator(`[data-asset="${suffix}"]`).getAttribute('href'), `${releases}latest/download/Sillage-${suffix}`)
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
  console.log('PASS all four pages without JavaScript in both themes, including captures, features and package links')

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
  assert.deepEqual(diagnostics, [], 'Unexpected browser errors')
  console.log(`PASS ${internalLinks.size} internal links and all local images, fonts, styles and scripts under /sillage/`)
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
}
