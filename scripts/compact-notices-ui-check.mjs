import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { chromium } from 'playwright'

// Check real components with a mocked API; no real conversation.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: web, stdio: 'pipe',
})
let diagnostics = ''
vite.stderr.on('data', (chunk) => { diagnostics += chunk.toString() })
vite.stdout.resume()
let browser
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(origin).then((response) => response.ok).catch(() => false)) { ready = true; break }
    await setTimeout(100)
  }
  assert.ok(ready, diagnostics || 'Vite failed to start')
  // Full Chromium is covered by the server's AppArmor profile.
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, locale: 'fr-FR' })
    const errors = []
    page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message) })
    await page.route('**/api/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await page.route('**/__notices_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="fr"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main id="check" class="space-y-3" style="max-width:720px;margin:24px auto;padding:16px"></main></body></html>' }))
    await page.goto(`${origin}/__notices_check`)
    await page.evaluate(async () => {
      const refresh = (await import('/@react-refresh')).default
      refresh.injectIntoGlobalHook(window)
      window.$RefreshReg$ = () => {}
      window.$RefreshSig$ = () => (type) => type
      window.__vite_plugin_react_preamble_installed__ = true
      document.documentElement.dataset.theme = 'dark'
      localStorage.setItem('sillage.locale', 'fr')
      await import('/src/styles/index.css')
      const React = (await import('/node_modules/.vite/deps/react.js')).default
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
      const { ChatThread } = await import('/src/components/chat/ChatThread.tsx')
      await (await import('/src/lib/i18n/index.ts')).initLocale()
      const { applyEvent, emptyChatState } = await import('/src/lib/chat-fold.ts')
      const { buildRows } = await import('/src/lib/tool-rows.ts')
      const source = await (await fetch('/src/lib/user-settings.ts')).text()
      const { QueryClient, QueryClientProvider } = await import(source.match(/from ["']([^"']*tanstack[^"']+)["']/)[1])
      const routerSource = await (await fetch('/src/routes/SettingsPage.tsx')).text()
      const { MemoryRouter } = await import(routerSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1])
      const client = new QueryClient()
      const root = createRoot(document.getElementById('check'))
      let state = emptyChatState()
      let seq = 0
      window.appendEvent = (event) => {
        state = applyEvent(state, ++seq, Date.now(), event)
        root.render(React.createElement(QueryClientProvider, { client },
          React.createElement(MemoryRouter, null, React.createElement(ChatThread, { rows: buildRows(state.items), conversationId: 'fixture', canDecide: true })),
        ))
      }

      const warning = { type: 'agent.notice', code: 'generic', level: 'warning', message: 'Under-development features enabled: default_mode_request_user_input. ' + 'Long original warning. '.repeat(30), details: { preserved: true } }
      window.appendEvent(warning)
      window.appendEvent({ ...warning, message: 'Different warning sharing the same code' })
      window.appendEvent({ type: 'error', code: 'fixture_failure', message: 'Blocking failure stays visible', recoverable: false })
      window.appendEvent(warning)
      window.appendEvent({ ...warning, details: { preserved: false } })
      window.appendEvent({ type: 'agent.notice', code: 'account/updated', level: 'info', message: 'Account updated' })
      window.warning = warning
    })
    const warnings = page.locator('[data-agent-notices="warning"]')
    await warnings.first().waitFor()
    assert.equal(await warnings.count(), 2)
    assert.equal(await warnings.first().locator(':scope > summary').innerText(), '2 avertissements\n· Détails')
    assert.ok(await page.getByText('Blocking failure stays visible', { exact: true }).isVisible())
    assert.equal(await page.getByText('Different warning sharing the same code', { exact: true }).isVisible(), false)
    assert.ok((await warnings.first().boundingBox()).height <= 40)
    await warnings.first().locator(':scope > summary').focus()
    await page.keyboard.press('Enter')
    await page.getByText('Different warning sharing the same code', { exact: true }).waitFor()
    await page.getByText('Répété 2 fois', { exact: true }).waitFor()
    await warnings.first().getByText('Détails techniques', { exact: true }).first().click()
    assert.ok(await warnings.first().getByText('"preserved": true', { exact: false }).first().isVisible())
    await page.evaluate(() => window.appendEvent(window.warning))
    await page.getByText('Répété 3 fois', { exact: true }).waitFor()
    assert.equal(await warnings.first().getAttribute('open'), '')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await warnings.first().locator(':scope > summary').click()
    await page.locator('#check').screenshot({ path: '/var/tmp/compact-notices-' + viewport.width + '.png' })
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('Compact notices: desktop and phone passed (shared Server/Desktop renderer).')
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
}
