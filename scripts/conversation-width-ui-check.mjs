import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Real components and local images, without daemon or production database.
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

async function mount(page) {
  await page.goto(origin)
  await page.evaluate(async () => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    await (await import('/src/lib/i18n/index.ts')).initLocale()
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { AppearanceControls } = await import('/src/components/AppearanceControls.tsx')
    const { useAppearance } = await import('/src/lib/appearance.ts')
    function Check() {
      const appearance = useAppearance()
      return React.createElement('main', null,
        React.createElement(AppearanceControls, { appearance, keys: ['conversationWidth'], swatches: false }),
        React.createElement('div', { id: 'thread', className: 'sg-conversation-width mx-auto' }, 'Message'))
    }
    createRoot(document.getElementById('check')).render(React.createElement(Check))
  })
}
try {
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then(r => r.ok).catch(() => false)) break
    if (vite.exitCode !== null) throw new Error(diagnostics)
    await delay(100)
  }
  browser = await chromium.launch({ chromiumSandbox: true })
  for (const width of [1920, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.route(`${origin}/`, route => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="check"></div></body></html>' }))
    await mount(page)
    const slider = page.getByRole('slider')
    await slider.waitFor()
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--sg-conversation-width').trim() === '768')
    const measure = () => page.locator('#thread').evaluate(el => el.getBoundingClientRect().width)
    assert.equal(await measure(), Math.min(768, width))
    await slider.fill('1280')
    assert.equal(await measure(), Math.min(1280, width))
    assert.equal(await page.evaluate(() => localStorage.getItem('sillage.conversationWidth')), '1280')
    await page.getByRole('button').click()
    assert.equal(await measure(), Math.min(768, width))
    assert.equal(await page.evaluate(() => localStorage.getItem('sillage.conversationWidth')), null)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.close()
  }
  console.log('Conversation width: desktop, mobile, live adjustment, persistence and reset OK')
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
}
