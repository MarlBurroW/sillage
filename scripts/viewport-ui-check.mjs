import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Les événements sont simulés : seul un iPad réel peut valider les calques WebKit.
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
try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) { ready = true; break }
    if (vite.exitCode !== null) break
    await delay(100)
  }
  assert.ok(ready, diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const size of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    for (const initiallyOpen of [false, true]) {
      const page = await browser.newPage({ viewport: size, hasTouch: true })
      await page.route('**/__viewport_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main class="app-layer" style="display:flex;flex-direction:column"><div style="flex:1;min-height:0;overflow:auto">Conversation</div><textarea aria-label="Message" style="flex-shrink:0"></textarea><button>Envoyer</button></main><div id="hook"></div></body></html>' }))
      await page.goto(`${origin}/__viewport_check`)
      await page.evaluate(async ({ initiallyOpen }) => {
        const refresh = (await import('/@react-refresh')).default
        refresh.injectIntoGlobalHook(window)
        window.$RefreshReg$ = () => {}
        window.$RefreshSig$ = () => (type) => type
        window.__vite_plugin_react_preamble_installed__ = true
        await import('/src/styles/index.css')
        const React = (await import('/node_modules/.vite/deps/react.js')).default
        const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
        const { useVisualViewport } = await import('/src/lib/viewport.ts')
        const height = window.innerHeight
        const vv = new EventTarget()
        Object.assign(vv, { height, offsetTop: 0 })
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
        window.recalibrations = 0
        const scrollTo = window.scrollTo.bind(window)
        window.scrollTo = (...args) => { window.recalibrations++; scrollTo(...args) }
        window.keyboard = (open, follows = false, emit = true) => {
          vv.height = open ? height - 320 : height
          vv.offsetTop = open ? 40 : 0
          Object.defineProperty(window, 'innerHeight', { configurable: true, value: follows ? vv.height : height })
          if (emit) vv.dispatchEvent(new Event('resize'))
        }
        if (initiallyOpen) {
          document.querySelector('textarea').focus()
          window.keyboard(true, true, false)
        }
        function Hook() { useVisualViewport(); return null }
        createRoot(document.getElementById('hook')).render(React.createElement(Hook))
      }, { initiallyOpen })
      await delay(100)
      const field = page.getByRole('textbox')
      await field.focus()
      for (const follows of [false, true]) {
        await page.evaluate((follows) => window.keyboard(true, follows), follows)
        const bounds = await field.boundingBox()
        assert.ok(bounds.y >= 40 && bounds.y + bounds.height <= size.height - 320 + 40, `Composer visible ${JSON.stringify({ size, initiallyOpen, follows, bounds })}`)
        await page.evaluate(() => window.visualViewport.dispatchEvent(new Event('scroll')))
      }
      await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
      assert.notEqual(await page.evaluate(() => document.documentElement.style.getPropertyValue('--sg-app-height')), '')
      // Une fermeture avec focus conservé doit encore recaler les zones de toucher.
      const before = await page.evaluate(() => window.recalibrations)
      await page.evaluate(() => window.keyboard(false))
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--sg-app-height')), '')
      assert.ok(await page.evaluate(() => window.recalibrations) > before)
      // Et le filet focusout reste actif si WebKit omet son événement de viewport.
      await page.evaluate(() => window.keyboard(true))
      const beforeBlur = await page.evaluate(() => window.recalibrations)
      await page.evaluate(() => { window.keyboard(false, false, false); document.querySelector('textarea').blur() })
      await delay(450)
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--sg-app-height')), '')
      assert.ok(await page.evaluate(() => window.recalibrations) > beforeBlur)
      await field.tap()
      assert.equal(await field.evaluate((node) => node === document.activeElement), true)
      await page.close()
    }
  }
  console.log('Viewport : bureau, iPad et téléphone ; ouverture, montage avec clavier, rotation, fermeture et toucher OK')
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
}
