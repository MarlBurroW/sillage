import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Real Markdown, file routes, SQLite and linked worktrees; no production state.
import { localImages } from '../apps/server/test/fixtures/local-images.ts'
const fixture = await localImages()
const backend = await fixture.app.listen({ port: 0, host: '127.0.0.1' })
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

const file = '.preview/image.png'

async function mount(page) {
  await page.goto(origin)
  await page.evaluate(async (absolute) => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    localStorage.setItem('sillage.locale', 'fr')
    // readableView runs outside render: label freezes, so load catalog first.
    await (await import('/src/lib/i18n/index.ts')).initLocale()
    document.documentElement.dataset.theme = 'dark'
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const querySource = await (await fetch('/src/lib/files.ts')).text()
    const queryModule = querySource.match(/from ["']([^"']*tanstack[^"']+)["']/)[1]
    const { QueryClient, QueryClientProvider } = await import(queryModule)
    const composerSource = await (await fetch('/src/components/chat/Composer.tsx')).text()
    const routerModule = composerSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1]
    const { MemoryRouter } = await import(routerModule)
    const { Markdown } = await import('/src/components/chat/Markdown.tsx')
    const { FileLinkContext } = await import('/src/lib/file-links.ts')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const client = new QueryClient()
    client.setQueryData(['auth', 'me'], { id: 'test-user' })
    const text = `![Relative](.preview/image.png)\n\n![Absolute](${absolute})\n\n![Outside](/var/tmp/private.png)`
    createRoot(document.getElementById('check')).render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(MemoryRouter, null,
          React.createElement(TooltipProvider, null,
            React.createElement(FileLinkContext.Provider, { value: 'session' },
              React.createElement(Markdown, { text }))))))
  }, fixture.linked + '/' + file)
}

try {
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) break
    if (vite.exitCode !== null) throw new Error(diagnostics)
    await delay(100)
  }
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 700, isMobile: width < 700, serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    const checked = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(`${origin}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="check"></div></body></html>' }))
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/files/exist')) checked.push(...route.request().postDataJSON().paths)
      if (url.pathname.includes('/file')) {
        const response = await route.fetch({ url: backend + url.pathname + url.search })
        return route.fulfill({ response })
      }
      return route.fulfill({ json: [] })
    })
    await mount(page)
    for (const name of ['Relative', 'Absolute']) {
      const image = page.getByRole('img', { name, exact: true })
      await image.waitFor()
      await image.evaluate(img => img.decode())
      assert.equal(await image.evaluate(img => img.naturalWidth), 1)
      const button = page.getByRole('button', { name, exact: true })
      if (width < 700) await button.tap()
      else { await button.focus(); await page.keyboard.press('Enter') }
      await page.getByRole('dialog').getByRole('heading', { name, exact: true }).waitFor()
      await page.keyboard.press('Escape')
    }
    assert.ok(checked.includes(file))
    assert.equal(await page.getByRole('img', { name: 'Outside' }).count(), 0)
    assert.equal(await page.getByText('Outside', { exact: true }).count(), 1)
    await page.screenshot({ path: `/var/tmp/local-images-${width}.png` })
    assert.deepEqual(errors, [])
    console.log(`Linked worktree Markdown images: ${width}px OK`)
    await context.close()
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  await fixture.close()
}
