import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Mounts the Agents pane on a subagent thread folded from real-shaped events, with no daemon: a
// background subagent (model status, activity at the bottom, stop button, report of a command it
// launched) and a foreground one (no stop button), then Codex sub-agents as Codex 0.172.0 reports
// them (model and effort on the Agent call, a grandchild under its parent), then Grok sub-agents
// as the runner reports Grok Build 1.0.62's (type and model added to the call once Grok announces
// the sub-agent, a background one still working), on a wide screen and a phone.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.SUBAGENT_UI_OUTPUT ?? '/var/tmp/sillage-subagent-pane'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
const errors = []

async function mount(page, selected) {
  await page.goto(origin + '/__subagent_check')
  await page.evaluate(async (selected) => {
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

    const tool = (id, parent, name, input) => ({ type: 'tool.started', parentToolCallId: parent, toolCallId: id, name, input })
    const done = (id, output) => ({ type: 'tool.completed', toolCallId: id, output, isError: false, durationMs: 40 })
    const events = [
      // Background subagent: its call returns at once, the task keeps going.
      tool('call-bg', null, 'Agent', { description: 'Construire le bibliothécaire', subagent_type: 'general-purpose', run_in_background: true }),
      { type: 'task.started', taskId: 'task-bg', toolCallId: 'call-bg', kind: 'local_agent', description: 'Construire le bibliothécaire' },
      done('call-bg', 'Async agent launched successfully.'),
      { type: 'background.updated', tasks: [{ id: 'task-bg', kind: 'local_agent', description: 'Construire le bibliothécaire' }] },
      tool('read-1', 'call-bg', 'Read', { file_path: '/srv/studio/bibliotheque.mjs' }),
      done('read-1', 'export function bibliotheque() {}'),
      // A command the subagent left running: its report must land here, not in the main thread.
      tool('bash-1', 'call-bg', 'Bash', { command: 'npm test', description: 'Run baseline test suite', run_in_background: true }),
      { type: 'task.started', taskId: 'task-bash', toolCallId: 'bash-1', kind: 'local_bash', description: 'Run baseline test suite' },
      done('bash-1', 'Command running in background'),
      { type: 'background.updated', tasks: [{ id: 'task-bg', kind: 'local_agent', description: 'Construire le bibliothécaire' }, { id: 'task-bash', kind: 'local_bash', description: 'Run baseline test suite' }] },
      { type: 'task.completed', taskId: 'task-bash', status: 'completed', summary: 'Background command "Run baseline test suite" completed (exit code 0)' },
      tool('edit-1', 'call-bg', 'Edit', { file_path: '/srv/studio/bibliotheque.mjs' }),
      { type: 'task.progress', taskId: 'task-bg', activity: 'Editing bibliotheque.mjs', lastTool: 'Edit', toolUses: 3, totalTokens: 34400, durationMs: 41000, summary: 'Branche le bibliothécaire sur la page Retours' },
      // Foreground subagent: the turn waits on it, so the turn's own stop covers it.
      tool('call-fg', null, 'Agent', { description: 'Relire les tests', subagent_type: 'Explore' }),
      { type: 'task.started', taskId: 'task-fg', toolCallId: 'call-fg', kind: 'local_agent', description: 'Relire les tests' },
      tool('grep-1', 'call-fg', 'Grep', { pattern: 'bibliotheque' }),
    ]
    // Codex 0.172.0: the runner turns each subAgentActivity into an Agent call carrying the
    // resolved model and effort; the grandchild is announced on its parent's thread.
    const codex = [
      tool('codex-relay', null, 'Agent', { description: '/root/relay', prompt: 'Relaie la question', model: 'gpt-6.1-terra', effort: 'medium' }),
      { type: 'task.started', taskId: 'relay', toolCallId: 'codex-relay', kind: 'agent', description: '/root/relay' },
      tool('codex-pong', 'codex-relay', 'Agent', { description: '/root/relay/pong', prompt: 'Réponds PONG', model: 'gpt-6.2-sol', effort: 'low' }),
      { type: 'task.started', taskId: 'pong', toolCallId: 'codex-pong', kind: 'agent', description: '/root/relay/pong' },
      tool('codex-read', 'codex-pong', 'Read', { file_path: '/srv/studio/pong.txt' }),
    ]
    // Grok 1.0.62, shaped as the runner turned a real run: `subagent_spawned` adds type and model to
    // the spawning call, the thread streams under it, the background one outlives its call.
    const grokType = (id, model) => ({ type: 'tool.input_updated', toolCallId: id, name: 'Agent', input: { description: id === 'grok-fg' ? 'Lire les notes' : 'Dire pong', prompt: 'Lis notes.txt', subagent_type: 'general-purpose', model } })
    const grok = [
      tool('grok-fg', null, 'Agent', { description: 'Lire les notes', prompt: 'Lis notes.txt', run_in_background: false }),
      { type: 'task.started', taskId: 'grok-a', toolCallId: 'grok-fg', kind: 'agent', description: 'Lire les notes', subagentType: 'general-purpose' },
      grokType('grok-fg', 'grok-4.7'),
      tool('grok-read', 'grok-fg', 'Read', { file_path: '/srv/studio/notes.txt' }),
      done('grok-read', '1→alpha'),
      { type: 'message.completed', messageId: 'grok-m1', role: 'assistant', blocks: [{ type: 'text', text: 'alpha' }], parentToolCallId: 'grok-fg' },
      { type: 'task.progress', taskId: 'grok-a', activity: '', lastTool: null, toolUses: 2, totalTokens: 10881, durationMs: 1491 },
      { type: 'task.completed', taskId: 'grok-a', status: 'completed', summary: 'alpha', durationMs: 1491 },
      done('grok-fg', 'alpha'),
      tool('grok-bg', null, 'Agent', { description: 'Dire pong', prompt: 'Réponds pong', run_in_background: true }),
      done('grok-bg', 'Subagent started in background.\nsubagent_id: grok-b'),
      { type: 'task.started', taskId: 'grok-b', toolCallId: 'grok-bg', kind: 'agent', description: 'Dire pong', subagentType: 'general-purpose' },
      grokType('grok-bg', 'grok-4.7-build-fast'),
      tool('grok-ls', 'grok-bg', 'LS', { path: '/srv/studio' }),
    ]
    const isCodex = selected.startsWith('codex-')
    const isGrok = selected.startsWith('grok-')
    if (isCodex) events.splice(0, events.length, ...codex)
    if (isGrok) events.splice(0, events.length, ...grok)
    let state = emptyChatState()
    events.forEach((event, index) => { state = applyEvent(state, index + 1, 1795545600000 + index * 1000, sillageEventSchema.parse(event)) })
    window.mainThreadTasks = state.items.filter((item) => item.kind === 'task' && item.parentToolCallId === null).length
    const agents = buildSubAgents(state.items, state.tasks)
    const wide = window.innerWidth >= 600
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client: new QueryClient() },
      React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null,
        React.createElement('aside', { id: 'pane', className: 'flex h-dvh min-h-0 flex-col border border-line', style: { width: wide ? 420 : '100%' } },
          React.createElement(AgentsPane, { conversationId: 'fixture', agent: isCodex ? 'codex' : isGrok ? 'grok' : 'claude', agents, background: [],
            workflows: new Map(), selectedId: selected === 'codex-list' || selected === 'grok-list' ? null : selected }))))))
  }, selected)
  const heading = { 'call-bg': 'Construire le bibliothécaire', 'call-fg': 'Relire les tests', 'grok-list': 'Lire les notes', 'grok-fg': 'Lire les notes', 'grok-bg': 'Dire pong' }[selected] ?? '/root/relay'
  await page.locator('#pane').getByText(heading).first().waitFor()
}

async function context(width, height, stops) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', hasTouch: width < 600 })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((path) => { window.protocolEvents = path }, fileURLToPath(new URL('../packages/protocol/src/events.ts', import.meta.url)))
  await page.route('**/__subagent_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="check"></div></body></html>' }))
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/stop')) stops.push(new URL(route.request().url()).pathname)
    return route.fulfill({ status: 202, json: { accepted: true } })
  })
  return { context, page }
}

try {
  for (let i = 0; i < 150; i++) { if (await fetch(origin).then((r) => r.ok).catch(() => false)) break; await delay(100) }
  browser = await chromium.launch()
  for (const [name, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
    const stops = []
    const { context: ctx, page } = await context(width, height, stops)
    await mount(page, 'call-bg')
    const pane = page.locator('#pane')
    // The model's status in the header, the mechanical activity at the bottom of the thread.
    assert.match(await pane.innerText(), /general-purpose · Branche le bibliothécaire sur la page Retours/)
    await pane.getByText('Editing bibliotheque.mjs').waitFor()
    // The command the subagent launched reports in its thread, and only there.
    await pane.getByText('Run baseline test suite').first().waitFor()
    assert.equal(await page.evaluate(() => window.mainThreadTasks), 0)
    await page.screenshot({ path: `${output}/${name}-background.png`, fullPage: true })

    // Stop goes to the subagent's task and stays pending until the CLI drops it.
    const stop = pane.getByRole('button', { name: 'Arrêter ce sous-agent' })
    await stop.click()
    assert.deepEqual(stops, ['/api/conversations/fixture/background/task-bg/stop'])
    assert.equal(await stop.isDisabled(), true)
    await ctx.close()

    // The turn waits on a foreground subagent: no stop of its own.
    const fg = await context(width, height, [])
    await mount(fg.page, 'call-fg')
    assert.equal(await fg.page.getByRole('button', { name: 'Arrêter ce sous-agent' }).count(), 0)
    await fg.page.screenshot({ path: `${output}/${name}-foreground.png`, fullPage: true })
    await fg.context.close()

    // Codex: each row names its model and effort, the grandchild sits indented under its parent.
    const codex = await context(width, height, [])
    await mount(codex.page, 'codex-list')
    const list = codex.page.locator('#pane')
    const relayRow = list.getByRole('button', { name: /\/root\/relay\b(?!\/)/ })
    const pongRow = list.getByRole('button', { name: /\/root\/relay\/pong/ })
    assert.match(await relayRow.innerText(), /Agent · gpt-6\.1-terra · Effort : Moyen/)
    assert.match(await pongRow.innerText(), /Agent · gpt-6\.2-sol · Effort : Faible/)
    // The pane cuts the end of a long line: the whole of it stays one hover away.
    assert.match(await relayRow.locator('[title]').getAttribute('title'), /gpt-6\.1-terra · Effort : Moyen · Agent en cours/)
    const indent = async (row) => (await row.boundingBox()).x
    assert.ok(await indent(pongRow) > await indent(relayRow), 'grandchild indented under its parent')
    // A narrow pane truncates the line rather than wrapping or overflowing it.
    const overflow = await list.evaluate((pane) => pane.scrollWidth - pane.clientWidth)
    assert.ok(overflow <= 0, `pane overflows by ${overflow}px`)
    await codex.page.screenshot({ path: `${output}/${name}-codex-list.png`, fullPage: true })
    await codex.context.close()

    const thread = await context(width, height, [])
    await mount(thread.page, 'codex-pong')
    assert.match(await thread.page.locator('#pane').innerText(), /Agent · gpt-6\.2-sol · Effort : Faible/)
    await thread.page.screenshot({ path: `${output}/${name}-codex-thread.png`, fullPage: true })
    await thread.context.close()

    // Grok: type and model on each row, the background one still working; no stop (Grok has none).
    const grok = await context(width, height, [])
    await mount(grok.page, 'grok-list')
    const grokPane = grok.page.locator('#pane')
    assert.match(await grokPane.getByRole('button', { name: /Lire les notes/ }).innerText(), /general-purpose · grok-4\.7(?!-)/)
    assert.match(await grokPane.getByRole('button', { name: /Dire pong/ }).innerText(), /general-purpose · grok-4\.7-build-fast/)
    assert.equal(await grokPane.getByRole('button', { name: 'Arrêter ce sous-agent' }).count(), 0)
    const grokOverflow = await grokPane.evaluate((pane) => pane.scrollWidth - pane.clientWidth)
    assert.ok(grokOverflow <= 0, `pane overflows by ${grokOverflow}px`)
    await grok.page.screenshot({ path: `${output}/${name}-grok-list.png`, fullPage: true })
    await grok.context.close()

    // Its thread: what it read and answered, under the spawning call.
    const grokThread = await context(width, height, [])
    await mount(grokThread.page, 'grok-fg')
    await grokThread.page.locator('#pane').getByText('alpha').first().waitFor()
    assert.match(await grokThread.page.locator('#pane').innerText(), /notes\.txt/)
    await grokThread.page.screenshot({ path: `${output}/${name}-grok-thread.png`, fullPage: true })
    await grokThread.context.close()
  }
  assert.deepEqual(errors, [])
  console.log(`OK: model status, bottom activity, stop of a background subagent only, report in the subagent thread, Codex model and effort with nesting, Grok type and model, wide screen and phone. Screenshots in ${output}`)
} catch (error) { console.error(diagnostics, errors); throw error }
finally { await browser?.close(); vite.kill('SIGTERM'); await once(vite, 'exit').catch(() => {}) }
