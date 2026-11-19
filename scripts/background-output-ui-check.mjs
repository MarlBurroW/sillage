import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Mounts the Agents pane with a background shell, a long truncated one, an ended one and a
// workflow, on a wide screen and a phone, with no daemon: the output route is answered here and
// grows on every read, like a running command.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.BACKGROUND_UI_OUTPUT ?? '/var/tmp/sillage-background-output'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
const errors = []

async function mount(page) {
  await page.goto(origin + '/__background_check')
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
    const source = await (await fetch('/src/lib/user-settings.ts')).text()
    const { QueryClient, QueryClientProvider } = await import(source.match(/from ["']([^"']*tanstack[^"']+)["']/)[1])
    const { AgentsPane } = await import('/src/components/panel/AgentsPane.tsx')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')

    const work = (id, kind, description) => ({
      id, kind, description, activity: null, lastTool: null, toolUses: 0, totalTokens: 0, workflowName: null, workflow: null,
    })
    const background = [
      work('shell', 'local_bash', 'pnpm test --watch'),
      work('long', 'local_bash', 'docker compose logs -f'),
      work('gone', 'local_bash', 'sleep 600'),
      { ...work('wf', 'local_workflow', 'Revue en parallèle'), workflowName: 'review' },
    ]
    const wide = window.innerWidth >= 600
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client: new QueryClient() },
      React.createElement(TooltipProvider, null,
        React.createElement('main', { className: 'flex h-dvh p-3' },
          React.createElement('aside', { id: 'pane', className: 'flex min-h-0 shrink-0 flex-col border border-line', style: { width: wide ? 380 : '100%' } },
            React.createElement(AgentsPane, { conversationId: 'fixture', agent: 'claude', agents: [], background, selectedId: null }))))))
  })
  await page.locator('#pane button[aria-expanded]').first().waitFor()
}

async function context(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', hasTouch: width < 600 })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/__background_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="check"></div></body></html>' }))
  // Registered first: Playwright tries the most recent route first, so the output route below wins.
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }))
  const reads = new Map()
  await page.route('**/api/conversations/fixture/background/*/output', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2))
    const count = (reads.get(id) ?? 0) + 1
    reads.set(id, count)
    if (id === 'gone') return route.fulfill({ status: 404, json: { error: 'background_output_unavailable', message: 'gone' } })
    if (id === 'long') {
      const lines = Array.from({ length: 200 + count * 5 }, (_, i) => `web-1  | GET /api/item/${i} 200`)
      const text = lines.join('\n') + '\n'
      return route.fulfill({ json: { output: text.slice(-8192), totalBytes: text.length + 50_000, truncated: true } })
    }
    // Colour codes and a progress bar redrawn with carriage returns, as a test runner prints them.
    const ticks = Array.from({ length: count }, (_, i) => `\u001b[32m✓\u001b[0m test ${i + 1}`).join('\n')
    return route.fulfill({ json: { output: `${ticks}\n[##  ] 20%\r[####] 100%\n`, totalBytes: 64, truncated: false } })
  })
  return { context, page, reads }
}

try {
  for (let i = 0; i < 150; i++) { if (await fetch(origin).then((r) => r.ok).catch(() => false)) break; await delay(100) }
  browser = await chromium.launch()
  for (const [name, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
    const { context: ctx, page, reads } = await context(width, height)
    await mount(page)
    const pane = page.locator('#pane')
    const row = (description) => pane.locator('button[aria-expanded]', { hasText: description })

    // Shells unfold; the workflow does not pretend to have output, and nothing is read before a click.
    assert.equal(await pane.locator('button[aria-expanded]').count(), 3)
    assert.equal(await row('Revue en parallèle').count(), 0)
    assert.equal(reads.size, 0)

    await row('pnpm test').click()
    assert.equal(await row('pnpm test').getAttribute('aria-expanded'), 'true')
    const shellOutput = pane.locator('pre').first()
    await shellOutput.waitFor()
    const first = await shellOutput.innerText()
    assert.doesNotMatch(first, /\u001b|\[32m/)
    assert.match(first, /✓ test 1/)
    assert.match(first, /\[####\] 100%/)
    assert.doesNotMatch(first, /20%/)
    // Polling brings new lines while the row stays open.
    await pane.getByText('✓ test 3').waitFor({ timeout: 6000 })

    await row('docker compose').click()
    const longOutput = pane.locator('pre').nth(1)
    await longOutput.waitFor()
    assert.match(await pane.innerText(), /Fin de la sortie : \d+([,.]\d+)? ko sur \d+([,.]\d+)? ko/)
    // Follows the end, like a terminal.
    const atEnd = () => longOutput.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 8)
    assert.ok(await atEnd())

    await row('sleep 600').click()
    await pane.getByText('Sortie indisponible : la session ou la tâche est terminée.').waitFor()
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true })

    // Scrolled up, the reader keeps their place when new lines arrive.
    await longOutput.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')) })
    const before = reads.get('long')
    for (let i = 0; i < 60 && reads.get('long') === before; i++) await delay(100)
    await delay(200)
    assert.equal(await longOutput.evaluate((node) => node.scrollTop), 0)

    // Closing stops the reads.
    await row('pnpm test').click()
    assert.equal(await pane.locator('pre').count(), 1)
    const stopped = reads.get('shell')
    await delay(2000)
    assert.equal(reads.get('shell'), stopped)
    await ctx.close()
  }
  assert.deepEqual(errors, [])
  console.log(`OK: shell rows unfold, polling, ANSI and redraw cleanup, truncation note, end-follow, unavailable state, wide screen and phone. Screenshots in ${output}`)
} catch (error) { console.error(diagnostics); throw error }
finally { await browser?.close(); vite.kill('SIGTERM'); await once(vite, 'exit').catch(() => {}) }
