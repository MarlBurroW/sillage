import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// The status line under the real composer, with its settings dialog; mocked API, no CLI launched.
const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const shots = process.env.STATUS_BAR_SHOTS ?? '/var/tmp/sillage-status-bar-ui'
await mkdir(shots, { recursive: true })
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser

const efforts = [{ value: 'medium', label: 'Moyen', hint: 'Réflexion intermédiaire' }]
const models = [{ value: 'alpha', displayName: 'Modèle Alpha', description: 'Premier modèle', hint: null, isDefault: true, efforts, defaultEffort: 'medium' }]
const config = { agent: 'claude', model: 'alpha', effort: 'medium', permissionMode: 'manual', strictMcp: false, sillageMcp: true, mcpServers: [] }
const everything = ['cli', 'quota', 'context', 'tokens', 'lastTurn', 'cost', 'agents', 'clock', 'model', 'version', 'worktree', 'files', 'tools', 'previews', 'shortcuts']

async function mount(page) {
  await page.goto(`${origin}/__status_bar_check`)
  await page.evaluate(async () => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    localStorage.setItem('sillage.locale', 'fr')
    document.documentElement.dataset.theme = 'dark'
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const hookSource = await (await fetch('/src/lib/conversation-config.ts')).text()
    const { QueryClient, QueryClientProvider } = await import(hookSource.match(/from ["']([^"']*tanstack[^"']+)["']/)[1])
    const composerSource = await (await fetch('/src/components/chat/Composer.tsx')).text()
    const { MemoryRouter } = await import(composerSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1])
    const { initLocale } = await import('/src/lib/i18n/index.ts')
    await initLocale()
    const { Composer } = await import('/src/components/chat/Composer.tsx')
    const { StatusBar } = await import('/src/components/chat/status-bar/StatusBar.tsx')
    const { StatusBarSettings } = await import('/src/components/chat/status-bar/StatusBarSettings.tsx')
    const { useStatusBar } = await import('/src/lib/status-bar.ts')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const { useVisualViewport } = await import('/src/lib/viewport.ts')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const config = window.__config
    function Harness() {
      useVisualViewport()
      const { items } = useStatusBar()
      const [open, setOpen] = React.useState(false)
      const [running, setRunning] = React.useState(false)
      window.setRunning = setRunning
      const data = {
        agent: 'claude', warm: running,
        windows: [
          { id: 'five_hour', label: '5 heures', utilization: 0.42, resetsAt: Date.now() + 80 * 60_000 },
          { id: 'seven_day', label: '7 jours', utilization: 0.18, resetsAt: Date.now() + 3 * 86_400_000 },
        ],
        context: { usedTokens: 58_000, maxTokens: 200_000, ratio: 0.29 },
        tokens: { input: 18_400, output: 41_200, cacheWrite: 96_000, cacheRead: 1_062_000 },
        lastTurnTokens: 85_300, costUsd: 4.12,
        subAgents: running ? ['Explore', 'Plan'] : [], background: running ? ['npm run dev'] : [],
        turnStartedAt: running ? Date.now() - 134_000 : null,
        model: 'claude-opus-5-5', cliVersion: '2.1.332', versionGap: null,
        worktree: { name: 'feat/x', branch: 'feat/x', state: 'unmerged', ahead: 3, pullRequest: { number: 27 }, conversations: [] },
        files: 7, tools: { calls: 84, errors: 2 }, previews: [{ port: 5173, title: 'Démo' }],
      }
      return React.createElement(Composer, {
        config, draftKey: 'status-bar-check', status: running ? 'running' : 'idle', disabled: false, projectId: 'demo',
        commands: [], skills: [], mcpInventory: [], appliedConfig: null,
        context: { usedTokens: 58_000, maxTokens: 200_000, ratio: 0.29 },
        onConfigChange: () => {}, onSend: async () => {}, onInterrupt: () => {},
        footer: React.createElement(React.Fragment, null,
          React.createElement(StatusBar, { items, data, onConfigure: () => setOpen(true), onOpen: (place) => { window.opened = place } }),
          React.createElement(StatusBarSettings, { open, onOpenChange: setOpen, agent: 'claude' })),
      })
    }
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null, React.createElement(Harness)))))
  })
  await page.locator('[data-status-bar]').first().waitFor()
}

try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) { ready = true; break }
    if (vite.exitCode !== null) break
    await delay(100)
  }
  assert.ok(ready, diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const sizes = [
    { name: 'desktop', viewport: { width: 1440, height: 900 }, touch: false },
    { name: 'phone', viewport: { width: 390, height: 844 }, touch: true },
    { name: 'tablet', viewport: { width: 1024, height: 768 }, touch: true },
  ]
  for (const { name, viewport, touch } of sizes) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, locale: 'fr-FR', serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    if (process.env.STATUS_BAR_DEBUG) page.on('console', (message) => console.log('console', message.type(), message.text().slice(0, 300)))
    if (process.env.STATUS_BAR_DEBUG) page.on('pageerror', (error) => console.log('pageerror', error.message.slice(0, 500)))
    const account = { agentDefaults: {}, collapsedProjects: [], hiddenAgents: [], appearance: null, notifications: {}, composerLayout: { claude: [] }, statusBar: null }
    const saved = []
    await page.addInitScript((value) => { window.__config = value }, config)
    await page.route('**/__status_bar_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="fr"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main class="app-layer" style="display:flex;flex-direction:column;justify-content:flex-end;height:100%"><div id="check"></div></main></body></html>' }))
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/api/me/settings') {
        if (request.method() === 'PATCH') {
          account.statusBar = request.postDataJSON().statusBar
          saved.push(account.statusBar)
        }
        return route.fulfill({ json: account })
      }
      if (path.endsWith('/models')) return route.fulfill({ json: { models, modes: [], account: null, fetchedAt: Date.now() } })
      if (path === '/api/mcp/servers') return route.fulfill({ json: { servers: [], sillageServer: true } })
      if (path === '/api/conversations') return route.fulfill({ json: [] })
      if (path === '/api/projects') return route.fulfill({ json: [] })
      return route.fulfill({ json: {} })
    })
    await mount(page)

    const bar = page.locator('[data-status-bar]').first()
    const insert = page.getByRole('button', { name: 'Raccourcis — aides de saisie', exact: true })
    const field = page.getByPlaceholder('Écris ton message…', { exact: true })
    await field.waitFor()

    // Default line: CLI state, busiest quota, tokens; agents hide while nothing runs.
    const text = async () => (await bar.innerText()).replace(/\s+/g, ' ').trim()
    assert.match(await text(), /5 h/)
    assert.match(await text(), /1\.2 M tok|1,2 M tok/)
    assert.doesNotMatch(await text(), /sous-agent/)
    if (name !== 'phone') assert.match(await text(), /Session au repos/)

    // One line, centred on the shortcuts trigger beside it.
    const centre = async (locator) => { const box = await locator.boundingBox(); return box.y + box.height / 2 }
    const row = bar.locator(':scope > :not([aria-hidden])').first()
    assert.ok(Math.abs(await centre(row) - await centre(insert)) <= 1, `${name}: line and shortcuts trigger are not centred together`)
    assert.ok((await row.boundingBox()).height <= 45, `${name}: the line wrapped`)
    // Phones keep only the glyphs on the trigger, leaving the line room.
    assert.equal(await insert.getByText('Raccourcis', { exact: true }).count(), name === 'phone' ? 0 : 1)

    // A running turn brings agents and background tasks, and they go when it ends.
    await page.evaluate(() => window.setRunning(true))
    await row.getByText(name === 'phone' ? '3' : '2 sous-agents · 1 tâche', { exact: true }).waitFor()
    await page.screenshot({ path: join(shots, `${name}-running.png`) })
    await page.evaluate(() => window.setRunning(false))

    const dialog = page.getByRole('dialog', { name: 'Barre d’état' })
    if (!touch) {
      // Hover gives the detail, a click leads where the figure comes from.
      const quota = bar.getByRole('button', { name: /5 h/ })
      await quota.hover()
      await page.getByRole('tooltip').filter({ hasText: '42 % utilisés' }).first().waitFor()
      await quota.click()
      assert.equal(await page.evaluate(() => window.opened), 'usage')
      await page.mouse.move(0, 0)
      await page.getByRole('button', { name: 'Personnaliser la barre d’état' }).click()
    } else {
      // Touch screens have no hover: the line opens the full list, which leads to the settings.
      await bar.getByRole('button', { name: 'Infos de la session' }).click()
      const sheet = page.getByRole('dialog', { name: 'Infos de la session' })
      await sheet.getByText('Quota · 5 h').waitFor()
      await page.screenshot({ path: join(shots, `${name}-sheet.png`) })
      await sheet.getByRole('button', { name: /Quota · 5 h/ }).click()
      assert.equal(await page.evaluate(() => window.opened), 'usage')
      await bar.getByRole('button', { name: 'Infos de la session' }).click()
      await sheet.getByRole('button', { name: 'Personnaliser la barre' }).click()
    }
    await dialog.waitFor()
    await dialog.getByText('Valeurs d’exemple, pendant un tour.', { exact: false }).waitFor()

    // Switching an item on saves the whole line at once and shows it.
    await dialog.getByRole('switch', { name: 'Afficher Contexte' }).click()
    await page.waitForFunction(() => document.querySelector('[data-status-preview]')?.textContent?.includes('29 %'))
    assert.ok(saved.at(-1).some((item) => item.key === 'context' && item.on), 'context switched on')
    // Formats: the quota as a ring; every window instead of the busiest.
    await dialog.locator('[data-status-item="quota"]').getByRole('radio', { name: 'Anneau' }).click()
    await dialog.locator('[data-status-item="quota"]').getByRole('radio', { name: 'Toutes' }).click()
    assert.deepEqual(saved.at(-1).find((item) => item.key === 'quota'), { key: 'quota', on: true, format: 'ring', windows: 'all' })
    // The preview tells what another CLI leaves out.
    await dialog.getByRole('radio', { name: 'OpenCode' }).click()
    await dialog.getByText(/Non fourni par OpenCode : Quota du compte/).waitFor()
    // Keyboard reordering: tokens move up one place.
    const order = () => saved.at(-1).map((item) => item.key)
    const before = order().indexOf('tokens')
    await dialog.getByRole('button', { name: 'Déplacer Tokens de la session' }).focus()
    // dnd-kit animates each step: pressing faster than it settles drops the move.
    for (const key of ['Space', 'ArrowUp', 'Space']) { await page.keyboard.press(key); await delay(150) }
    await delay(150)
    assert.equal(order().indexOf('tokens'), before - 1, 'tokens moved up')
    await page.screenshot({ path: join(shots, `${name}-settings.png`) })
    await dialog.getByRole('button', { name: 'Terminé' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await row.getByText('Contexte', { exact: false }).or(row.locator('svg')).first().waitFor()

    // Everything on: still one line, the rest behind "+N".
    account.statusBar = everything.map((key) => ({ key, on: true }))
    await page.reload()
    await mount(page)
    const crowded = page.locator('[data-status-bar]').first()
    const more = crowded.getByText(/^\+\d+$/)
    await more.waitFor()
    assert.ok((await crowded.locator(':scope > :not([aria-hidden])').first().boundingBox()).height <= 45, `${name}: the crowded line wrapped`)
    if (!touch) {
      await crowded.getByRole('button', { name: /de plus$/ }).click()
      await page.getByRole('dialog', { name: 'Infos de la session' }).or(page.locator('[role="dialog"][aria-label="Infos de la session"]')).first().waitFor()
      await page.screenshot({ path: join(shots, `${name}-more.png`) })
      await page.keyboard.press('Escape')
    } else {
      await page.screenshot({ path: join(shots, `${name}-crowded.png`) })
    }

    // Restoring the defaults sends null, so the default line can still evolve.
    if (touch) {
      await crowded.getByRole('button', { name: 'Infos de la session' }).click()
      await page.getByRole('button', { name: 'Personnaliser la barre' }).click()
    } else {
      await page.getByRole('button', { name: 'Personnaliser la barre d’état' }).click()
    }
    await dialog.getByRole('button', { name: 'Rétablir les défauts' }).click()
    assert.equal(saved.at(-1), null)

    assert.deepEqual(errors, [], `${name}: page errors`)
    await context.close()
    console.log(`status bar: ${name} ok`)
  }
} finally {
  await browser?.close()
  vite.kill()
}
