import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

/*
 * Update prompt: once a new service worker waits, the page says it was updated, names the version
 * it will load (from version.json), warns about unsent drafts, folds on "Later" without
 * disappearing, and reloads through the service worker. The PWA hook is replaced by a stub: a real
 * service worker cannot be made to wait on demand under Vite.
 */

const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.UPDATE_PROMPT_UI_OUTPUT ?? '/var/tmp/sillage-update-prompt-ui'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
const errors = []

const PWA_STUB = `
export function useRegisterSW() {
  return {
    needRefresh: [true, () => {}],
    offlineReady: [false, () => {}],
    updateServiceWorker: async () => { window.__reloadRequested = (window.__reloadRequested ?? 0) + 1 },
  }
}`

async function mount(page, { locale, draft }) {
  await page.goto(origin + '/__update_check')
  await page.evaluate(async ({ locale, draft }) => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    document.documentElement.dataset.theme = 'dark'
    localStorage.setItem('sillage.locale', locale)
    await (await import('/src/lib/i18n/index.ts')).initLocale()
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const routeSource = await (await fetch('/src/routes/SettingsPage.tsx')).text()
    const routerModule = routeSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1]
    const { MemoryRouter } = await import(routerModule)
    const { UpdatePrompt } = await import('/src/components/UpdatePrompt.tsx')
    const { saveDraft } = await import('/src/lib/composer-drafts.ts')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    window.__saveDraft = saveDraft
    if (draft) saveDraft('conversation-1', { text: 'Un message en cours', attachments: [], mentions: [], skills: [] })
    createRoot(document.getElementById('check')).render(
      React.createElement(MemoryRouter, null,
        React.createElement(TooltipProvider, null,
          React.createElement('main', { className: 'h-screen p-4 text-ink-faint' }, 'Contenu de l’application'),
          React.createElement(UpdatePrompt))))
  }, { locale, draft })
}

async function openContext(width, deployed) {
  const context = await browser.newContext({ viewport: { width, height: width < 700 ? 800 : 900 }, hasTouch: width < 700, isMobile: width < 700, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/__update_check', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body class="bg-canvas"><div id="check"></div></body></html>',
  }))
  await page.route(/virtual:pwa-register\/react/, (route) => route.fulfill({ contentType: 'text/javascript', body: PWA_STUB }))
  await page.route(/\/version\.json/, (route) => deployed
    ? route.fulfill({ json: { version: deployed, builtAt: new Date().toISOString() } })
    : route.fulfill({ status: 404, json: { error: { code: 'not_found' } } }))
  return { context, page }
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

  // Wide screen, a release, a draft pending.
  const wide = await openContext(1440, '0.46.0')
  await mount(wide.page, { locale: 'fr', draft: true })
  const prompt = wide.page.getByRole('status')
  await prompt.getByText('Sillage a été mis à jour').waitFor()
  await prompt.getByText('v0.46.0', { exact: true }).waitFor()
  await prompt.getByRole('link', { name: 'Nouveautés' }).waitFor()
  await prompt.getByText('Un message non envoyé sera perdu au rechargement.').waitFor()
  await delay(400)
  await wide.page.screenshot({ path: `${output}/update-desktop.png` })

  // The draft warning follows the drafts live.
  await wide.page.evaluate(() => window.__saveDraft('conversation-1', { text: '', attachments: [], mentions: [], skills: [] }))
  await prompt.getByText('Un message non envoyé').waitFor({ state: 'detached' })

  // "Later" folds rather than hides; the pill unfolds again and still reloads.
  await prompt.getByRole('button', { name: 'Plus tard' }).click()
  await prompt.getByRole('button', { name: 'v0.46.0 prête' }).waitFor()
  await wide.page.screenshot({ path: `${output}/update-desktop-folded.png`, clip: { x: 420, y: 0, width: 600, height: 90 } })
  await prompt.getByRole('button', { name: 'Recharger' }).click()
  assert.equal(await wide.page.evaluate(() => window.__reloadRequested), 1)
  await prompt.getByRole('button', { name: 'Rechargement…' }).waitFor()
  await wide.context.close()

  // A phone, a hot-deployed build past its tag: no notes link, the commit stays readable.
  const phone = await openContext(390, 'v0.46.0-4-gabc1234')
  await mount(phone.page, { locale: 'fr', draft: true })
  const phonePrompt = phone.page.getByRole('status')
  await phonePrompt.getByText('+4 · abc1234').waitFor()
  assert.equal(await phonePrompt.getByRole('link', { name: 'Nouveautés' }).count(), 0)
  await delay(400)
  await phone.page.screenshot({ path: `${output}/update-phone.png` })
  const box = await phonePrompt.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `The prompt fits a phone (${JSON.stringify(box)})`)
  await phone.context.close()

  // An older build without version.json: the prompt still explains, naming no version.
  const old = await openContext(1024, null)
  await mount(old.page, { locale: 'en', draft: false })
  const oldPrompt = old.page.getByRole('status')
  await oldPrompt.getByText('Sillage has been updated').waitFor()
  await oldPrompt.getByText('This page is still running the previous version', { exact: false }).waitFor()
  assert.equal(await oldPrompt.getByText(/^v\d/).count(), 0)
  await old.context.close()

  assert.deepEqual(errors, [])
  console.log(`update prompt UI check passed; screenshots in ${output}`)
} finally {
  await browser?.close()
  vite.kill()
}
