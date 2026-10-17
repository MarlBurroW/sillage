import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Composants réels et images locales, sans daemon ni base de production.
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
    localStorage.setItem('sillage.locale', 'fr')
    // readableView est appelé hors rendu : son libellé se fige, il faut le catalogue d'abord.
    await (await import('/src/lib/i18n/index.ts')).initLocale()
    document.documentElement.dataset.theme = 'dark'
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { Markdown } = await import('/src/components/chat/Markdown.tsx')
    const { ImageGallery } = await import('/src/components/chat/ImageViewer.tsx')
    const { readableView } = await import('/src/components/tools/registry.tsx')
    const canvas = document.createElement('canvas')
    canvas.width = 1600; canvas.height = 1000
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#367a90'; ctx.fillRect(0, 0, 1600, 1000)
    ctx.fillStyle = '#efc873'; ctx.fillRect(400, 200, 800, 600)
    const src = canvas.toDataURL('image/png')
    const root = document.getElementById('check')
    createRoot(root).render(React.createElement('main', null,
      React.createElement(Markdown, { text: `![markdown.png](${src})` }),
      React.createElement(ImageGallery, { images: [{ src, alt: 'generation.png' }, { src: canvas.toDataURL('image/jpeg'), alt: 'photo.jpg' }] }),
      readableView({ name: 'Read', input: { file_path: 'read.png' }, status: 'completed', output: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: src.split(',')[1] } }] }),
      readableView({ name: 'mcp_image', input: {}, status: 'completed', output: { content: [{ type: 'image', mimeType: 'image/png', data: src.split(',')[1] }] } })
    ))
  })
}

try {
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) break
    if (vite.exitCode !== null) throw new Error(diagnostics)
    await delay(100)
  }
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 700, isMobile: width < 700, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(`${origin}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="check"></div></body></html>' }))
    await mount(page)
    const opener = page.getByRole('button', { name: 'Agrandir l’image : generation.png', exact: true })
    console.log(width, 'ouverture')
    await opener.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText('1600 × 1000').waitFor()
    await dialog.getByRole('button', { name: 'Zoomer', exact: true }).click()
    await dialog.getByText('125%', { exact: true }).waitFor()
    const surface = dialog.locator('.touch-none')
    const box = await surface.boundingBox()
    await page.mouse.move(box.x + 100, box.y + 100)
    await page.mouse.down()
    await page.mouse.move(box.x + 130, box.y + 120)
    await page.mouse.up()
    assert.match(await dialog.locator('img').getAttribute('style'), /translate\(30px, 20px\)/)
    await dialog.getByRole('button', { name: 'Faire pivoter' }).click()
    assert.match(await dialog.locator('img').getAttribute('style'), /rotate\(90deg\)/)
    await dialog.getByRole('button', { name: 'Adapter à l’écran' }).click()
    await dialog.getByText('100%', { exact: true }).waitFor()
    const downloaded = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Télécharger l’original' }).click()
    assert.equal((await downloaded).suggestedFilename(), 'generation.png')
    console.log(width, 'copie')
    await dialog.getByRole('button', { name: 'Copier l’image' }).click()
    await dialog.getByText('Image copiée', { exact: true }).waitFor()
    assert.ok(await page.evaluate(async () => (await navigator.clipboard.read())[0].types.includes('image/png')))
    await page.keyboard.press('ArrowRight')
    await dialog.getByRole('heading', { name: 'photo.jpg' }).waitFor()
    console.log(width, 'copie')
    await dialog.getByRole('button', { name: 'Copier l’image' }).click()
    await dialog.getByText('Image copiée', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Taille réelle' }).click()
    assert.ok(await dialog.locator('img').evaluate((img) => img.getBoundingClientRect().width >= 1599))
    await dialog.getByRole('button', { name: 'Adapter à l’écran' }).click()
    if (width < 700) {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 130, y: 400, id: 1 }, { x: 230, y: 400, id: 2 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 90, y: 400, id: 1 }, { x: 270, y: 400, id: 2 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      assert.ok(await dialog.locator('img').evaluate((el) => Number(el.style.transform.match(/scale\(([^)]+)/)[1]) > 1))
      await dialog.getByRole('button', { name: 'Adapter à l’écran' }).click()
      await cdp.detach()
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: `/tmp/image-viewer-${width}.png` })
    console.log(width, 'fermeture')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Agrandir l’image : generation.png')
    await page.getByRole('button', { name: 'Agrandir l’image : read.png', exact: true }).click()
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Fermer', exact: true }).click()
    await page.getByRole('button', { name: 'Agrandir l’image : Visualisateur d’images', exact: true }).click()
    await dialog.waitFor()
    console.log(width, 'fermeture')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'markdown.png', exact: true }).click()
    await dialog.getByRole('heading', { name: 'markdown.png' }).waitFor()
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('OK : galerie, outils Read/MCP, zoom, rotation, taille réelle, copie PNG/JPEG, téléchargement, clavier et focus ; ordinateur et téléphone.')
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  await once(vite, 'exit')
}
