import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

/*
 * Appearance › Fonts: choosing a family applies it to the whole interface and the account, a
 * family saved on another device is adopted, and "System" restores the platform stack untouched.
 */

const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.FONTS_UI_OUTPUT ?? '/var/tmp/sillage-fonts-ui'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
let appearance = { theme: 'dark', syntax: 'sillage', values: {} }
const errors = []

async function mount(page) {
  await page.goto(origin + '/__fonts_check')
  await page.evaluate(async () => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    document.documentElement.dataset.theme = 'dark'
    localStorage.setItem('sillage.locale', 'fr')
    await (await import('/src/lib/i18n/index.ts')).initLocale()
    await import('/src/styles/index.css')
    await (await import('/src/lib/fonts.ts')).restoreFonts()
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const settingsSource = await (await fetch('/src/lib/user-settings.ts')).text()
    const queryModule = settingsSource.match(/from ["']([^"']*tanstack[^"']+)["']/)[1]
    const { QueryClient, QueryClientProvider } = await import(queryModule)
    const routeSource = await (await fetch('/src/routes/SettingsPage.tsx')).text()
    const routerModule = routeSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1]
    const { MemoryRouter } = await import(routerModule)
    const { AppearanceSection } = await import('/src/routes/AppearanceSection.tsx')
    const { useAppearanceSync } = await import('/src/lib/appearance-sync.ts')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    function Screen() {
      useAppearanceSync()
      return React.createElement('main', { className: 'mx-auto flex h-screen max-w-3xl flex-col p-4' },
        React.createElement('p', { id: 'sample-text' }, 'Texte courant'),
        React.createElement('code', { id: 'sample-code', className: 'font-mono' }, 'const x = 1'),
        React.createElement(AppearanceSection))
    }
    createRoot(document.getElementById('check')).render(
      React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        React.createElement(MemoryRouter, null,
          React.createElement(TooltipProvider, null, React.createElement(Screen)))))
  })
  await page.getByRole('navigation', { name: 'Catégories d’apparence' }).getByRole('link', { name: 'Polices', exact: true }).click()
  await page.getByRole('group', { name: 'Police de l\'interface', exact: true }).waitFor()
}

async function openContext(width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 700, isMobile: width < 700, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/__fonts_check', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="check"></div></body></html>',
  }))
  await page.route('**/api/me/settings', async (route) => {
    if (route.request().method() === 'PATCH') appearance = route.request().postDataJSON().appearance
    await route.fulfill({ json: { appearance } })
  })
  return { context, page }
}

const family = (page, selector) => page.locator(selector).evaluate((node) => getComputedStyle(node).fontFamily)
const loaded = (page, name) => page.evaluate((name) => document.fonts.check(`400 16px "${name}"`), name)
async function waitSaved(slot, id) {
  for (let i = 0; i < 40 && appearance.fonts?.[slot] !== id; i++) await delay(50)
  assert.equal(appearance.fonts?.[slot], id)
}

try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) { ready = true; break }
    if (vite.exitCode !== null) break
    await delay(100)
  }
  assert.ok(ready, diagnostics)
  browser = await chromium.launch()

  const first = await openContext(1440)
  await mount(first.page)
  const sans = first.page.getByRole('group', { name: 'Police de l\'interface', exact: true })
  const mono = first.page.getByRole('group', { name: 'Police du code', exact: true })
  assert.equal(await sans.getByRole('button').count(), 11)
  assert.equal(await mono.getByRole('button').count(), 9)
  assert.equal(await sans.locator('[aria-pressed="true"]').innerText().then((text) => text.includes('Système')), true)
  const systemSans = await family(first.page, '#sample-text')
  assert.match(systemSans, /^ui-sans-serif/, 'The default stays the platform stack')

  // Previews draw each card in its family: opening the tab loads them.
  for (let i = 0; i < 60 && !(await loaded(first.page, 'Manrope Variable')); i++) await delay(100)
  assert.ok(await loaded(first.page, 'Manrope Variable'), 'Previews load their family')
  await first.page.screenshot({ path: `${output}/fonts-desktop-system.png`, fullPage: true })

  await sans.getByRole('button', { name: /Inter/ }).click()
  assert.match(await family(first.page, '#sample-text'), /^"Inter Variable", ui-sans-serif/)
  await waitSaved('sans', 'inter')
  await mono.getByRole('button', { name: /JetBrains Mono/ }).click()
  assert.match(await family(first.page, '#sample-code'), /^"JetBrains Mono Variable"/)
  await waitSaved('mono', 'jetbrains-mono')
  assert.equal(await first.page.evaluate(() => localStorage.getItem('sillage.fontSans')), 'inter')
  await first.page.screenshot({ path: `${output}/fonts-desktop-inter.png`, fullPage: true })

  // Another device, on a phone: the account's choice is adopted, then reset to the system stack.
  appearance = { ...appearance, fonts: { sans: 'figtree', mono: 'fira-code' } }
  const second = await openContext(390)
  await mount(second.page)
  for (let i = 0; i < 40 && !(await family(second.page, '#sample-text')).startsWith('"Figtree'); i++) await delay(50)
  assert.match(await family(second.page, '#sample-text'), /^"Figtree Variable"/)
  assert.match(await family(second.page, '#sample-code'), /^"Fira Code Variable"/)
  await second.page.screenshot({ path: `${output}/fonts-phone-figtree.png`, fullPage: true })
  const phoneWidth = await second.page.evaluate(() => document.documentElement.scrollWidth)
  assert.ok(phoneWidth <= 390, `No horizontal overflow on a phone (${phoneWidth}px)`)

  await second.page.getByRole('group', { name: 'Police de l\'interface', exact: true }).getByRole('button', { name: /Système/ }).click()
  assert.equal(await family(second.page, '#sample-text'), systemSans)
  assert.equal(await second.page.evaluate(() => document.documentElement.style.getPropertyValue('--sg-font-sans')), '')
  assert.equal(await second.page.evaluate(() => localStorage.getItem('sillage.fontSans')), null)
  await waitSaved('sans', 'system')

  // An unknown family (removed since saving) falls back to the system stack.
  appearance = { ...appearance, fonts: { sans: 'gone-font', mono: null } }
  const third = await openContext(1024)
  await mount(third.page)
  assert.equal(await family(third.page, '#sample-text'), systemSans)

  assert.deepEqual(errors, [])
  console.log(`fonts UI check passed; screenshots in ${output}`)
} finally {
  await browser?.close()
  vite.kill()
}
