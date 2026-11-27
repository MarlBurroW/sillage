// Reasoning must read differently from tool calls in every tool style, unfold while written and
// fold once the answer starts. Screenshots go to THINKING_UI_OUTPUT.
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
const output = process.env.THINKING_UI_OUTPUT ?? '/var/tmp/sillage-thinking'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let browser
const errors = []

async function mount(page, toolStyle) {
  await page.goto(origin + '/__thinking_check')
  await page.evaluate(async (toolStyle) => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    document.documentElement.dataset.theme = 'dark'
    localStorage.setItem('sillage.locale', 'fr')
    localStorage.setItem('sillage.toolStyle', toolStyle)
    await (await import('/src/lib/i18n/index.ts')).initLocale()
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const source = await (await fetch('/src/lib/user-settings.ts')).text()
    const { QueryClient, QueryClientProvider } = await import(source.match(/from ["']([^"']*tanstack[^"']+)["']/)[1])
    const routerSource = await (await fetch('/src/routes/SettingsPage.tsx')).text()
    const { MemoryRouter } = await import(routerSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1])
    const { ChatThread } = await import('/src/components/chat/ChatThread.tsx')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const { buildRows } = await import('/src/lib/tool-rows.ts')
    const { applyToolStyle } = await import('/src/lib/tool-style.ts')
    applyToolStyle(toolStyle)
    const tool = (id, name, input) => ({ kind: 'tool', id, name, ts: 0, input, output: 'ok', outputBytes: null, status: 'done', durationMs: 120, parentToolCallId: null })
    const message = (id, blocks, extra = {}) => ({ kind: 'message', id, role: 'assistant', ts: 0, seq: 1, blocks, streamingText: '', streamingThinking: '', parentToolCallId: null, ...extra })
    const long = Array.from({ length: 14 }, (_, i) => `Étape ${i + 1} : je relis le découpage de \`agent-requests.ts\` et je vérifie que le handler suit la même convention.`).join('\n\n')
    window.cases = {
      done: [
        message('m1', [{ type: 'thinking', text: '**Listing primes through 60**\n\nI need the primes up to 60, then a count. Checking `2, 3, 5, 7` first.' }, { type: 'text', text: 'Je regarde les fichiers concernés.' }]),
        tool('t1', 'Read', { file_path: 'apps/server/src/agents/codex/runner.ts' }),
        tool('t2', 'Bash', { command: 'pnpm test', description: 'Lancer les tests' }),
        tool('t3', 'mcp__sillage__read_memory', {}),
        message('m2', [{ type: 'thinking', text: 'Le conflit ne concerne que les imports, car main a découpé `agent-requests.ts` par type de requête. Je déplace mon handler dans `agent-requests-previews.ts` pour suivre ce découpage.' }, { type: 'text', text: 'C’est corrigé, les 18 tests passent.' }]),
      ],
      live: [
        tool('t1', 'Read', { file_path: 'apps/server/src/agents/codex/runner.ts' }),
        message('m3', [], { streamingThinking: long }),
      ],
      liveShort: [message('m4', [], { streamingThinking: 'Je vérifie le découpage.' })],
      answering: [message('m3', [], { streamingThinking: long, streamingText: 'Voici le résultat.' })],
    }
    function Screen() {
      const [items, setItems] = React.useState(window.cases.done)
      window.setItems = setItems
      return React.createElement('main', { className: 'mx-auto max-w-3xl p-4' },
        React.createElement(ChatThread, { rows: buildRows(items, null, false), conversationId: 'fixture', mayCollapseTools: false }))
    }
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null, React.createElement(Screen)))))
  }, toolStyle)
  await page.locator('.sg-thinking').first().waitFor()
}

try {
  for (let i = 0; i < 150; i++) { if (await fetch(origin).then((r) => r.ok).catch(() => false)) break; await delay(100) }
  browser = await chromium.launch()
  for (const width of [1440, 390]) {
    for (const style of ['console', 'inline', 'cards']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/__thinking_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="check"></div></body></html>' }))
      await page.route('**/api/**', (route) => route.fulfill({ json: {} }))
      await mount(page, style)
      const thinking = page.locator('.sg-thinking')
      // Finished reasoning is folded, titled by its first line without Markdown marks.
      assert.equal(await thinking.first().locator('.sg-thinking-body').count(), 0)
      assert.equal(await thinking.first().locator('.sg-thinking-preview').innerText(), 'Listing primes through 60')
      // No frame or background: a tool row's box must not be mistaken for reasoning.
      const box = await thinking.first().evaluate((node) => { const s = getComputedStyle(node); return [s.borderTopWidth, s.backgroundColor] })
      assert.deepEqual(box, ['0px', 'rgba(0, 0, 0, 0)'])
      await page.screenshot({ path: `${output}/${style}-${width}-folded.png`, fullPage: true })
      await thinking.nth(1).locator('.sg-thinking-heading').click()
      assert.match(await thinking.nth(1).locator('.sg-thinking-body').innerText(), /agent-requests-previews\.ts/)
      assert.equal(await thinking.nth(1).locator('.sg-thinking-body code').count(), 2, 'Markdown is rendered')
      await page.screenshot({ path: `${output}/${style}-${width}-open.png`, fullPage: true })
      if (style === 'console') {
        await page.evaluate(() => window.setItems(window.cases.live))
        const live = page.locator('.sg-thinking-live')
        await live.locator('.sg-thinking-clipped').waitFor()
        assert.match(await live.locator('.sg-thinking-body').innerText(), /Étape 14/)
        await page.screenshot({ path: `${output}/live-${width}.png`, fullPage: true })
        await page.evaluate(() => window.setItems(window.cases.liveShort))
        await page.locator('.sg-thinking-live .sg-thinking-body').waitFor()
        assert.equal(await page.locator('.sg-thinking-clipped').count(), 0, 'Short reasoning is not faded')
        await page.evaluate(() => window.setItems(window.cases.answering))
        await page.waitForFunction(() => !document.querySelector('.sg-thinking-body'))
        assert.equal(await page.locator('.sg-thinking-live').count(), 0, 'Folds once the answer starts')
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow')
      await context.close()
    }
  }
  assert.deepEqual(errors, [])
  console.log(`thinking UI check passed; screenshots in ${output}`)
} finally {
  await browser?.close()
  vite.kill()
}
