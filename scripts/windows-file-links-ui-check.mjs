import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Exercise Windows file citations with the real Markdown and editor, without a Windows host or daemon.
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

const file = 'D:/projets/ai-studio/outputs/maybe/Maybe-voix-Eleven-v4.mp3'

async function mount(page) {
  await page.goto(origin)
  await page.evaluate(async () => {
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
    const { EditorPane } = await import('/src/components/panel/EditorPane.tsx')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const client = new QueryClient()
    client.setQueryData(['auth', 'me'], { id: 'test-user' })
    const text = '[Écouter l’échantillon](/D:/projets/ai-studio/outputs/maybe/Maybe-voix-Eleven-v4.mp3)'
      + '\n\n[Missing](/D:/missing.mp3)'
    createRoot(document.getElementById('check')).render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(MemoryRouter, null,
          React.createElement(TooltipProvider, null,
            React.createElement(FileLinkContext.Provider, { value: 'test-session' },
              React.createElement(Markdown, { text }),
              React.createElement(EditorPane, { scope: 'test-session' }))))))
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
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 700, isMobile: width < 700, serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    const checked = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(`${origin}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="check"></div></body></html>' }))
    await page.route('**/api/**', (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/files/exist')) {
        const { paths } = route.request().postDataJSON()
        checked.push(...paths)
        return route.fulfill({ json: { files: paths.filter((path) => path === file) } })
      }
      if (url.pathname.endsWith('/file/raw')) return route.fulfill({ status: 204 })
      return route.fulfill({ json: [] })
    })
    await mount(page)
    const link = page.getByRole('button', { name: 'Écouter l’échantillon', exact: true })
    await link.waitFor()
    assert.ok(checked.includes(file))
    assert.equal(await page.getByRole('link', { name: 'Missing', exact: true }).count(), 0)
    await link.focus()
    if (width > 700) await page.keyboard.press('Enter')
    else await link.tap()
    await page.locator('audio[controls]').waitFor()
    const src = await page.locator('audio').getAttribute('src')
    assert.equal(new URL(src, origin).searchParams.get('path'), file)
    assert.equal(context.pages().length, 1)
    assert.equal(page.url(), origin + '/')

    const cases = await page.evaluate(async () => {
      const { parseMarkdown } = await import('/src/lib/markdown.ts')
      const targets = [
        '/D:/projets/ai-studio/outputs/maybe/Maybe-voix-Eleven-v4.mp3',
        'D:/projets/ai-studio/sample.mp3',
        '/d:/projets/Voix%20française/sample.mp3',
        'D:%5Cprojets%5Csample.mp3',
        '/home/demo/sample.mp3',
        'outputs/sample.mp3',
        'https://example.com/sample.mp3',
        'mailto:demo@example.com',
        '//example.com/sample.mp3',
      ]
      return targets.map((target) => {
        const text = `[Sample](<${target}>)`
        const first = parseMarkdown(text, { base: 'docs' })
        const known = parseMarkdown(text, { base: 'docs', knownFiles: first.candidates })
        return { candidates: [...first.candidates], html: known.segments.map((s) => s.html).join('') }
      })
    })
    assert.deepEqual(cases.map((c) => c.candidates), [
      [file], ['D:/projets/ai-studio/sample.mp3'], ['d:/projets/Voix française/sample.mp3'],
      ['D:/projets/sample.mp3'], ['/home/demo/sample.mp3'], ['docs/outputs/sample.mp3'], [], [], [],
    ])
    for (const item of cases.slice(0, 6)) assert.match(item.html, /data-sg-path=/)
    for (const item of cases.slice(6)) assert.match(item.html, /target="_blank"/)
    assert.deepEqual(errors, [])
    console.log(`Windows file links → audio editor: ${width}px OK`)
    await context.close()
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
}
