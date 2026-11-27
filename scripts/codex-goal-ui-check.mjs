import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// A Codex thread goal in the Agents pane (card #122), on events shaped like the runner's for
// codex-cli 0.172.0, with no daemon: an active goal is background work whose stop button pauses
// it, while a Codex sub-agent beside it keeps no stop button (Codex cannot stop one). Wide screen
// and phone.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.CODEX_GOAL_UI_OUTPUT ?? '/var/tmp/sillage-codex-goal'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
const errors = []

async function mount(page) {
  await page.goto(origin + '/__codex_goal_check')
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
    const routerSource = await (await fetch('/src/routes/SettingsPage.tsx')).text()
    const { MemoryRouter } = await import(routerSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1])
    const { AgentsPane } = await import('/src/components/panel/AgentsPane.tsx')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const { applyEvent, emptyChatState, noticeText } = await import('/src/lib/chat-fold.ts')
    const { sillageEventSchema } = await import('/@fs' + window.protocolEvents)
    const { buildSubAgents } = await import('/src/lib/subagents.ts')
    const { buildBackground } = await import('/src/lib/background.ts')

    const goal = { objective: 'Améliorer les graphismes de Power Rush', status: 'active', tokensUsed: 813572, tokenBudget: 1000000, timeUsedSeconds: 5400 }
    const events = [
      { type: 'agent.notice', id: 'codex-goal:root', code: 'codex_goal', level: 'info', message: 'Codex goal (active): ' + goal.objective, details: goal },
      { type: 'background.updated', tasks: [
        { id: 'child', kind: 'agent', description: 'Euclid' },
        { id: 'codex-goal', kind: 'goal', description: goal.objective, stoppable: true },
      ] },
    ]
    let state = emptyChatState()
    events.forEach((event, index) => { state = applyEvent(state, index + 1, 1795545600000 + index * 1000, sillageEventSchema.parse(event)) })
    window.goalNotice = noticeText(state.items.find((item) => item.kind === 'notice'))
    const agents = buildSubAgents(state.items, state.tasks)
    const background = buildBackground(state)
    const wide = window.innerWidth >= 600
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client: new QueryClient() },
      React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null,
        React.createElement('aside', { id: 'pane', className: 'flex h-dvh min-h-0 flex-col border border-line', style: { width: wide ? 420 : '100%' } },
          React.createElement(AgentsPane, { conversationId: 'fixture', agent: 'codex', agents, background, workflows: new Map(), selectedId: null }))))))
  })
  await page.locator('#pane').getByText('Améliorer les graphismes de Power Rush').first().waitFor()
}

try {
  for (let i = 0; i < 150; i++) { if (await fetch(origin).then((r) => r.ok).catch(() => false)) break; await delay(100) }
  browser = await chromium.launch()
  for (const [name, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', hasTouch: width < 600 })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((path) => { window.protocolEvents = path }, fileURLToPath(new URL('../packages/protocol/src/events.ts', import.meta.url)))
    await page.route('**/__codex_goal_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="check"></div></body></html>' }))
    const stops = []
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === 'POST' && path.endsWith('/stop')) { stops.push(path); return route.fulfill({ status: 202, json: { accepted: true } }) }
      return route.fulfill({ json: {} })
    })
    await mount(page)
    const pane = page.locator('#pane')

    // The thread line says the state and the tokens spent against the budget, in French.
    // French groups thousands with a narrow no-break space.
    assert.equal((await page.evaluate(() => window.goalNotice)).replace(/\s/g, ' '), 'Objectif en cours : Améliorer les graphismes de Power Rush · 813 572 tokens sur 1 000 000')
    const section = pane.locator('section', { hasText: 'Travail de fond' })
    assert.match(await section.innerText(), /Objectif/)
    // Only the goal can be stopped: Codex has no stop for a sub-agent.
    const pause = pane.getByRole('button', { name: 'Suspendre cet objectif', exact: true })
    assert.equal(await pause.count(), 1)
    assert.equal(await pane.getByRole('button', { name: 'Arrêter ce travail de fond', exact: true }).count(), 0)
    await pause.click()
    for (let i = 0; i < 50 && stops.length === 0; i++) await delay(50)
    assert.deepEqual(stops, ['/api/conversations/fixture/background/codex-goal/stop'])
    const overflow = await pane.evaluate((node) => node.scrollWidth - node.clientWidth)
    assert.ok(overflow <= 0, `pane overflows by ${overflow}px`)
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true })
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log(`OK: the goal is stoppable background work, sub-agents are not, the thread line is translated; wide screen and phone. Screenshots in ${output}`)
} catch (error) { console.error(diagnostics); throw error }
finally { await browser?.close(); vite.kill('SIGTERM'); await once(vite, 'exit').catch(() => {}) }
