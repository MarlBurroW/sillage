import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.TYPING_UI_OUTPUT ?? '/var/tmp/sillage-typing-integrated'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
let appearance = { theme: 'dark', syntax: 'sillage', values: {} }
let writes = 0
const errors = []

async function mount(page) {
  await page.goto(origin + '/__typing_check')
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
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const settingsSource = await (await fetch('/src/lib/user-settings.ts')).text()
    const queryModule = settingsSource.match(/from ["']([^"']*tanstack[^"']+)["']/)[1]
    const { QueryClient, QueryClientProvider } = await import(queryModule)
    const routeSource = await (await fetch('/src/routes/SettingsPage.tsx')).text()
    const routerModule = routeSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1]
    const { MemoryRouter } = await import(routerModule)
    const { AppearanceSection } = await import('/src/routes/AppearanceSection.tsx')
    const { TurnActivity } = await import('/src/components/chat/TurnActivity.tsx')
    const { useAppearanceSync } = await import('/src/lib/appearance-sync.ts')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    function Screen() {
      useAppearanceSync()
      return React.createElement('main', { className: 'mx-auto max-w-3xl p-4' },
        React.createElement('div', { id: 'live-turn', className: 'mb-6' }, React.createElement(TurnActivity, { label: 'Rédaction' })),
        React.createElement(AppearanceSection))
    }
    createRoot(document.getElementById('check')).render(
      React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        React.createElement(MemoryRouter, null,
          React.createElement(TooltipProvider, null, React.createElement(Screen)))))
  })
  await page.getByRole('group', { name: 'Indicateur d’activité', exact: true }).waitFor()
}

async function openContext(width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 700, isMobile: width < 700, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/__typing_check', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="check"></div></body></html>',
  }))
  // Real hooks complete their round trips; account is shared across contexts.
  await page.route('**/api/me/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      appearance = route.request().postDataJSON().appearance
      writes++
    }
    await route.fulfill({ json: { appearance } })
  })
  return { context, page }
}

async function expectStyle(page, variant) {
  await page.locator('#live-turn .sg-typing-' + variant).waitFor()
  const group = page.getByRole('group', { name: 'Indicateur d’activité', exact: true })
  assert.equal(await group.locator('[aria-pressed="true"]').count(), 1)
}
async function waitSaved(variant) {
  for (let i = 0; i < 40 && appearance.typingIndicator !== variant; i++) await delay(50)
  assert.equal(appearance.typingIndicator, variant)
}

try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) { ready = true; break }
    if (vite.exitCode !== null) break
    await delay(100)
  }
  assert.ok(ready, diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const first = await openContext(1440)
  await mount(first.page)
  await expectStyle(first.page, 'sillage')
  const choices = first.page.getByRole('group', { name: 'Indicateur d’activité', exact: true })
  assert.equal(await choices.getByRole('button').count(), 6)
  assert.equal(await choices.getByRole('button', { name: 'Sillage', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await first.page.locator('#live-turn').innerText(), 'Rédaction')
  for (const [name, variant] of [['Onde', 'wave'], ['Orbite', 'orbit'], ['Encre', 'ink'], ['Constellation', 'constellation'], ['Souffle', 'breath'], ['Sillage', 'sillage']]) {
    await choices.getByRole('button', { name, exact: true }).click()
    await expectStyle(first.page, variant)
  }
  const card = first.page.locator('.surface').filter({ has: first.page.getByRole('heading', { name: 'Indicateur d’activité', exact: true }) })
  for (const theme of ['Clair', 'Sombre', 'Sombre contrasté']) {
    await first.page.getByRole('button', { name: theme, exact: true }).click()
    await delay(150)
    await card.screenshot({ path: output + '/desktop-' + theme + '.png' })
  }
  await first.page.getByRole('button', { name: 'Sombre', exact: true }).click()
  await choices.getByRole('button', { name: 'Orbite', exact: true }).focus()
  await first.page.keyboard.press('Enter')
  await expectStyle(first.page, 'orbit')
  await waitSaved('orbit')
  assert.equal(await first.page.evaluate(() => localStorage.getItem('sillage.typingIndicator')), 'orbit')
  await mount(first.page)
  await expectStyle(first.page, 'orbit')
  await first.context.close()

  // A device without cache retrieves the account choice, including on phones.
  const second = await openContext(390)
  await mount(second.page)
  await expectStyle(second.page, 'orbit')
  assert.equal(await second.page.evaluate(() => localStorage.getItem('sillage.typingIndicator')), 'orbit')
  const mobileCard = second.page.locator('.surface').filter({ has: second.page.getByRole('heading', { name: 'Indicateur d’activité', exact: true }) })
  await mobileCard.screenshot({ path: output + '/mobile-dark.png' })
  assert.ok(await second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await second.page.setViewportSize({ width: 320, height: 844 })
  assert.ok(await second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await second.page.emulateMedia({ reducedMotion: 'reduce' })
  const mobileChoices = second.page.getByRole('group', { name: 'Indicateur d’activité', exact: true })
  await mobileChoices.getByRole('button', { name: 'Encre', exact: true }).click()
  await expectStyle(second.page, 'ink')
  assert.equal(await second.page.locator('#live-turn .sg-typing-ink-draw').evaluate((el) => getComputedStyle(el).animationName), 'none')
  assert.equal(await second.page.locator('#live-turn .sg-typing-ink-draw').evaluate((el) => getComputedStyle(el).opacity), '0.8')
  await mobileChoices.getByRole('button', { name: 'Sillage', exact: true }).click()
  await waitSaved('sillage')
  assert.equal(await second.page.evaluate(() => localStorage.getItem('sillage.typingIndicator')), null)
  await second.context.close()

  // Account is authoritative even over old cache; a removed name stays readable.
  for (const saved of [undefined, 'removed-style']) {
    appearance = { theme: 'dark', syntax: 'sillage', values: {}, ...(saved ? { typingIndicator: saved } : {}) }
    const legacy = await openContext(1440)
    await legacy.context.addInitScript(() => localStorage.setItem('sillage.typingIndicator', 'orbit'))
    await mount(legacy.page)
    await expectStyle(legacy.page, 'sillage')
    await legacy.context.close()
  }
  assert.deepEqual(errors, [])
  assert.ok(writes > 0)
  console.log('OK : six mouvements, Sillage par défaut, compte et rechargement, autre appareil, anciens réglages, clavier, trois thèmes, téléphone et mouvement réduit.')
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  if (vite.exitCode === null) await once(vite, 'exit')
}

