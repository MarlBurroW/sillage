import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Codex free quota resets in the real usage panel, against a mocked API: no CLI is started and no
// reset of any real account is spent.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser

const expiresAt = Date.UTC(2026, 11, 3, 12)
const usage = (available) => ({
  agent: 'codex', plan: 'pro', limitsAvailable: true, fetchedAt: Date.now(), credits: null,
  windows: [{ id: 'codex:primary', label: '7 jours', utilization: available === 3 ? 1 : 0, resetsAt: Date.now() + 3 * 86_400_000 }],
  resetCredits: available > 0 ? { available, nextExpiresAt: expiresAt, title: 'Full reset', description: "Thanks for using Codex! You've been granted one free rate limit reset." } : null,
})

async function mount(page, account) {
  await page.goto(`${origin}/__usage_check`)
  await page.evaluate(async (account) => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    localStorage.setItem('sillage.locale', 'fr')
    document.documentElement.dataset.theme = 'light'
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const hookSource = await (await fetch('/src/lib/usage.ts')).text()
    const queryModule = hookSource.match(/from ["']([^"']*tanstack[^"']+)["']/)[1]
    const { QueryClient, QueryClientProvider } = await import(queryModule)
    const { UsagePanel } = await import('/src/components/chat/UsagePanel.tsx')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client },
      React.createElement(TooltipProvider, null, React.createElement(UsagePanel, { agent: 'codex', account, open: true, onOpenChange: () => {} }))))
  }, account)
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
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const who of ['admin', 'member']) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 700, isMobile: viewport.width < 700, locale: 'fr-FR', serviceWorkers: 'block' })
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      let available = 3
      const resets = []
      await page.route('**/__usage_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="fr"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="check"></div></body></html>' }))
      await page.route('**/api/**', async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (path === '/api/auth/me') return route.fulfill({ json: { id: who, username: who, displayName: who, isAdmin: who === 'admin' } })
        if (path === '/api/agents/codex/usage/reset') {
          resets.push(request.postDataJSON())
          available -= 1
          return route.fulfill({ json: { outcome: 'reset', resumed: 2 } })
        }
        if (path === '/api/agents/codex/usage') return route.fulfill({ json: usage(available) })
        return route.fulfill({ json: {} })
      })
      // The member looks at the CLI's own login: the resets are shown but belong to the admin.
      await mount(page, null)
      const section = page.locator('[data-usage-resets]')
      await section.getByText('Réinitialisations offertes', { exact: true }).waitFor()
      await section.getByText('3 disponible(s)', { exact: true }).waitFor()
      await section.getByText(/La prochaine expire le 3 décembre\./).waitFor()
      const use = section.getByRole('button', { name: 'Utiliser une réinitialisation', exact: true })
      if (who === 'member') {
        assert.equal(await use.count(), 0)
        await section.getByText(/Seul un administrateur/).waitFor()
      } else {
        // Nothing is spent without the explicit confirmation, and cancelling spends nothing.
        await use.click()
        const dialog = page.getByRole('dialog', { name: 'Utiliser une réinitialisation offerte ?' })
        await dialog.getByText(/consommée pour de bon/).waitFor()
        await dialog.getByRole('button', { name: 'Annuler', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        assert.deepEqual(resets, [])
        await use.click()
        const bounds = await dialog.boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, 'The confirmation fits the screen')
        await dialog.getByRole('button', { name: 'Utiliser la réinitialisation', exact: true }).click()
        await section.getByRole('status').getByText(/reprennent dans la minute/).waitFor()
        assert.deepEqual(resets, [{ account: null }])
        // The panel reads usage again: one reset fewer.
        await section.getByText('2 disponible(s)', { exact: true }).waitFor()
        await page.screenshot({ path: `/var/tmp/sillage-audit-codex/usage-resets-${viewport.width}.png` })
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      assert.deepEqual(errors, [])
      console.log(`OK ${viewport.width}×${viewport.height} (${who}): resets listed, admin-only on the CLI login, confirmation, outcome, refetch`)
      await context.close()
    }
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  if (vite.exitCode === null) await once(vite, 'exit')
}
