import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Mounts the Agents pane list on events shaped like Claude Code 2.1.332's (card #22), with no
// daemon: a sub-agent that left a shell running and started a nested sub-agent, a background
// sub-agent resumed by SendMessage, a backgrounded sub-agent whose launch is not in the thread,
// and a shell launched by an agent the pane does not know. Wide screen and phone.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.SUBAGENT_TREE_UI_OUTPUT ?? '/var/tmp/sillage-subagent-tree'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
const errors = []

async function mount(page) {
  await page.goto(origin + '/__subagent_tree_check')
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
    const { applyEvent, emptyChatState } = await import('/src/lib/chat-fold.ts')
    const { sillageEventSchema } = await import('/@fs' + window.protocolEvents)
    const { buildSubAgents } = await import('/src/lib/subagents.ts')
    const { buildBackground } = await import('/src/lib/background.ts')

    const tool = (id, parent, name, input) => ({ type: 'tool.started', parentToolCallId: parent, toolCallId: id, name, input })
    const done = (id, output) => ({ type: 'tool.completed', toolCallId: id, output, isError: false, durationMs: 40 })
    const shell = { id: 'brxobm9xs', kind: 'local_bash', description: 'pnpm dev --port 5173', parentTaskId: 'outer', runId: 'r2' }
    const resumed = { id: 'resumed', kind: 'local_agent', description: 'Relire la doc', subagentType: 'general-purpose', runId: 'r5' }
    const detached = { id: 'detached', kind: 'local_agent', description: 'Agent sans appel connu', subagentType: 'code-reviewer', runId: 'r6' }
    const orphan = { id: 'orphan', kind: 'local_bash', description: 'tail -f server.log', parentTaskId: 'forgotten', runId: 'r7' }
    const events = [
      tool('call-outer', null, 'Agent', { description: 'Câbler la page Retours', subagent_type: 'general-purpose' }),
      { type: 'task.started', taskId: 'outer', toolCallId: 'call-outer', kind: 'local_agent', description: 'Câbler la page Retours', subagentType: 'general-purpose', runId: 'r1' },
      tool('call-bash', 'call-outer', 'Bash', { command: 'pnpm dev --port 5173', run_in_background: true }),
      { type: 'task.started', taskId: shell.id, toolCallId: 'call-bash', kind: 'local_bash', description: shell.description, parentTaskId: 'outer', runId: 'r2' },
      done('call-bash', 'Command running in background'),
      tool('call-inner', 'call-outer', 'Agent', { description: 'Chercher les tests existants', subagent_type: 'Explore' }),
      { type: 'task.started', taskId: 'inner', toolCallId: 'call-inner', kind: 'local_agent', description: 'Chercher les tests existants', parentTaskId: 'outer', subagentType: 'Explore', runId: 'r3' },
      // Background sub-agent, finished then resumed under a SendMessage call.
      tool('call-resumed', null, 'Agent', { description: 'Relire la doc', subagent_type: 'general-purpose', run_in_background: true }),
      { type: 'task.started', taskId: 'resumed', toolCallId: 'call-resumed', kind: 'local_agent', description: 'Relire la doc', subagentType: 'general-purpose', runId: 'r4' },
      done('call-resumed', 'Async agent launched successfully.'),
      { type: 'task.completed', taskId: 'resumed', status: 'completed', summary: 'Lu.', runId: 'r4' },
      tool('call-send', null, 'SendMessage', { to: 'resumed', message: 'Et le chapitre 2 ?' }),
      { type: 'task.started', taskId: 'resumed', toolCallId: 'call-send', kind: 'local_agent', description: 'Relire la doc', subagentType: 'general-purpose', runId: 'r5' },
      done('call-send', 'Message sent'),
      { type: 'background.updated', tasks: [shell, resumed, detached, orphan] },
    ]
    let state = emptyChatState()
    events.forEach((event, index) => { state = applyEvent(state, index + 1, 1795545600000 + index * 1000, sillageEventSchema.parse(event)) })
    const agents = buildSubAgents(state.items, state.tasks)
    const background = buildBackground(state)
    const wide = window.innerWidth >= 600
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client: new QueryClient() },
      React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null,
        React.createElement('aside', { id: 'pane', className: 'flex h-dvh min-h-0 flex-col border border-line', style: { width: wide ? 420 : '100%' } },
          React.createElement(AgentsPane, { conversationId: 'fixture', agent: 'claude', agents, background, workflows: new Map(), selectedId: null }))))))
  })
  await page.locator('#pane').getByText('Câbler la page Retours').first().waitFor()
}

try {
  for (let i = 0; i < 150; i++) { if (await fetch(origin).then((r) => r.ok).catch(() => false)) break; await delay(100) }
  browser = await chromium.launch()
  for (const [name, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', hasTouch: width < 600 })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((path) => { window.protocolEvents = path }, fileURLToPath(new URL('../packages/protocol/src/events.ts', import.meta.url)))
    await page.route('**/__subagent_tree_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="check"></div></body></html>' }))
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }))
    await mount(page)
    const pane = page.locator('#pane')

    // The shell and the nested agent hang under the agent that launched them.
    const children = pane.locator('div.border-l').first()
    assert.match(await children.innerText(), /pnpm dev --port 5173[\s\S]*Chercher les tests existants/)
    const section = pane.locator('section', { hasText: 'Travail de fond' })
    assert.doesNotMatch(await section.innerText(), /pnpm dev/)
    // Unknown parent, or a sub-agent whose launch is not in the thread: at the root of the section,
    // the latter labelled with its agent type.
    assert.match(await section.innerText(), /tail -f server\.log/)
    assert.match(await section.innerText(), /Sous-agent · code-reviewer/)
    // The resumed agent is one running row, not a second background entry.
    assert.equal(await pane.getByText('Relire la doc', { exact: true }).count(), 1)
    assert.doesNotMatch(await section.innerText(), /Relire la doc/)
    // Rows stay inside the pane: nesting must not push them past its edge on a phone.
    const overflow = await pane.evaluate((node) => node.scrollWidth - node.clientWidth)
    assert.ok(overflow <= 0, `pane overflows by ${overflow}px`)
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true })
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log(`OK: work nests under its launcher, unknown parents stay at the root, a resumed agent is a single row, wide screen and phone. Screenshots in ${output}`)
} catch (error) { console.error(diagnostics); throw error }
finally { await browser?.close(); vite.kill('SIGTERM'); await once(vite, 'exit').catch(() => {}) }
