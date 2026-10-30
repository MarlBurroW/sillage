import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Mounts the Agents pane and a Workflow card on a three-phase workflow snapshot, on a wide screen
// and a phone, with no daemon: the components only read the folded state.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.WORKFLOW_UI_OUTPUT ?? '/var/tmp/sillage-workflow-progress'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
const errors = []

async function mount(page) {
  await page.goto(origin + '/__workflow_check')
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
    const { ChatThread } = await import('/src/components/chat/ChatThread.tsx')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const { buildRows } = await import('/src/lib/tool-rows.ts')
    const { WorkflowTasksContext } = await import('/src/lib/workflows.ts')

    const agent = (index, label, phaseIndex, state, extra = {}) => ({
      index, label, phaseIndex, state, model: 'claude-opus-5-5', lastTool: null, lastToolSummary: null,
      tokens: 0, toolCalls: 0, attempt: 1, error: null, ...extra,
    })
    window.snapshot = {
      phases: [{ index: 1, title: 'Fondations' }, { index: 2, title: 'Moteur' }, { index: 3, title: 'Intégration' }],
      agents: [
        agent(1, 'release', 1, 'done', { tokens: 210000, toolCalls: 60 }),
        agent(2, 'serveur', 1, 'running', { lastTool: 'Edit', lastToolSummary: '/home/marlburrow/projects/appartement-3d/collab/server/api.mjs', tokens: 180101, toolCalls: 21 }),
        agent(3, 'interface', 1, 'error', { error: 'blocked by safety classifier: writes outside its files', attempt: 2, tokens: 195920, toolCalls: 49 }),
        agent(4, 'moteur', 2, 'queued'),
      ],
    }
    const task = (workflow, done = false) => ({
      id: 'wbwx4la8w', toolCallId: 'call-wf', kind: 'local_workflow',
      description: 'Construit l’appli collaborative : release optimisée, serveur, interface, moteur FPS multijoueur, intégration',
      workflowName: 'appart-collab-build', workflow, activity: 'Fondations: serveur', lastTool: 'serveur',
      toolUses: 104, totalTokens: 566871, durationMs: 1185422, unattended: true, done, outcome: done ? 'completed' : null,
    })
    const item = {
      kind: 'tool', id: 'call-wf', name: 'Workflow', ts: 0, status: 'done', durationMs: 900, parentToolCallId: null,
      input: { script: "export const meta = { name: 'appart-collab-build' }" }, output: 'Workflow launched in background.', outputBytes: null,
    }
    function Screen() {
      const [state, setState] = React.useState({ workflow: window.snapshot, done: false })
      window.setWorkflow = setState
      const current = task(state.workflow, state.done)
      const background = state.done ? [] : [{ ...current, kind: current.kind }]
      const wide = window.innerWidth >= 600
      return React.createElement('main', { className: 'flex h-dvh gap-3 p-3', style: { flexDirection: wide ? 'row' : 'column' } },
        React.createElement('div', { id: 'thread', className: 'min-w-0 flex-1' },
          React.createElement(WorkflowTasksContext.Provider, { value: new Map([['call-wf', current]]) },
            React.createElement(ChatThread, { rows: buildRows([item], null, false), conversationId: 'fixture', mayCollapseTools: false }))),
        React.createElement('aside', { id: 'pane', className: 'flex min-h-0 shrink-0 flex-col border border-line', style: { width: wide ? 380 : '100%' } },
          React.createElement(AgentsPane, { conversationId: 'fixture', agent: 'claude', agents: [], background, selectedId: null })))
    }
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client: new QueryClient() },
      React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null, React.createElement(Screen)))))
  })
  await page.locator('#pane button[aria-label^="serveur"]').waitFor()
}

async function context(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', hasTouch: width < 600 })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/__workflow_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="check"></div></body></html>' }))
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }))
  return { context, page }
}

try {
  for (let i = 0; i < 150; i++) { if (await fetch(origin).then((r) => r.ok).catch(() => false)) break; await delay(100) }
  browser = await chromium.launch()
  for (const [name, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
    const { context: ctx, page } = await context(width, height)
    await mount(page)
    const pane = page.locator('#pane')
    // Phases in script order, the upcoming one marked, all four agents listed.
    assert.deepEqual(await pane.locator('h3').allInnerTexts().then((all) => all.map((text) => text.split('\n')[0].trim().toLowerCase())), ['fondations', 'moteur', 'intégration'])
    assert.match(await pane.locator('h3').nth(2).innerText(), /Pas encore commencée/i)
    for (const label of ['release', 'serveur', 'interface', 'moteur']) await pane.locator(`button[aria-label^="${label}"]`).waitFor()
    assert.match(await pane.innerText(), /appart-collab-build · Phase 1\/3/)
    assert.match(await pane.innerText(), /essai 2/)
    // The card says where the workflow stands, not just that it launched.
    const strip = page.locator('#thread [data-tool-id="call-wf"]')
    assert.match(await strip.innerText(), /Phase 1\/3 · Fondations · 1 agent actif · 1 en attente · 1 terminé · 1 en échec/)
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true })

    // A tap unfolds the details touch screens cannot get from a tooltip.
    const failing = pane.locator('button[aria-label^="interface"]')
    await failing.click()
    assert.equal(await failing.getAttribute('aria-expanded'), 'true')
    assert.match(await pane.innerText(), /blocked by safety classifier/)
    await page.screenshot({ path: `${output}/${name}-expanded.png`, fullPage: true })

    await page.evaluate(() => window.setWorkflow({ workflow: window.snapshot, done: true }))
    assert.match(await strip.innerText(), /Workflow terminé/)
    assert.equal(await strip.getByText('Voir ses agents').count(), 0)
    await ctx.close()
  }
  assert.deepEqual(errors, [])
  console.log(`OK: phases, agents, states, retry, card summary, tap details, wide screen and phone. Screenshots in ${output}`)
} catch (error) { console.error(diagnostics); throw error }
finally { await browser?.close(); vite.kill('SIGTERM'); await once(vite, 'exit').catch(() => {}) }
