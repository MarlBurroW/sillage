import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Real composer and save queue; mocked API, no CLI launched.
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

const efforts = [
  { value: 'low', label: 'Faible', hint: 'Réflexion limitée' },
  { value: 'medium', label: 'Moyen', hint: 'Réflexion intermédiaire' },
  { value: 'high', label: 'Élevé', hint: 'Réflexion approfondie' },
  // `xhigh` makes Ultracode available, therefore pinnable.
  { value: 'xhigh', label: 'Maximal', hint: 'Réflexion la plus longue' },
]
const models = [
  { value: 'alpha', displayName: 'Modèle Alpha', description: 'Premier modèle', hint: 'alpha-v1', isDefault: true, efforts, defaultEffort: 'medium' },
  { value: 'beta', displayName: 'Modèle Beta', description: 'Second modèle', hint: null, isDefault: false, efforts: efforts.slice(0, 2), defaultEffort: 'medium' },
  { value: 'none', displayName: 'Sans réflexion', description: 'Sans niveau configurable', hint: null, isDefault: false, efforts: [], defaultEffort: null },
]
const initial = {
  codex: { agent: 'codex', model: 'alpha', reasoningEffort: 'high', askForApproval: 'on-request', collaborationMode: 'default', sandbox: 'workspace-write', sillageMcp: true, mcpServers: [] },
  claude: { agent: 'claude', model: 'alpha', effort: 'high', permissionMode: 'manual', strictMcp: false, sillageMcp: true, mcpServers: [] },
}

async function mount(page) {
  await page.goto(`${origin}/__composer_check`)
  await page.evaluate(async () => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    localStorage.setItem('sillage.locale', 'fr')
    document.documentElement.dataset.theme = 'light'
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const hookSource = await (await fetch('/src/lib/conversation-config.ts')).text()
    const queryModule = hookSource.match(/from ["']([^"']*tanstack[^"']+)["']/)[1]
    const { QueryClient, QueryClientProvider } = await import(queryModule)
    const composerSource = await (await fetch('/src/components/chat/Composer.tsx')).text()
    const routerModule = composerSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1]
    const { MemoryRouter } = await import(routerModule)
    const { Composer } = await import('/src/components/chat/Composer.tsx')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const { useConversationConfig } = await import('/src/lib/conversation-config.ts')
    const { useConversation } = await import('/src/lib/conversations.ts')
    const { useVisualViewport } = await import('/src/lib/viewport.ts')
    const { api } = await import('/src/lib/api.ts')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    window.client = client
    function Harness() {
      const [id, setId] = React.useState('codex')
      const [disabled, setDisabled] = React.useState(false)
      const [catalog, setCatalog] = React.useState(false)
      useVisualViewport()
      const { data } = useConversation(id)
      const settings = useConversationConfig(data)
      window.setConversation = setId
      window.setReadOnly = setDisabled
      window.setCatalog = setCatalog
      window.settings = settings
      if (!settings.config) return null
      return React.createElement(Composer, {
        key: id, config: settings.config, draftKey: `composer-test-${id}`, status: 'idle', disabled,
        commands: catalog ? [{ name: 'review', aliases: [], description: 'Review the draft', argumentHint: '' }] : [],
        skills: catalog ? [{ name: 'writing', description: 'Edit prose', path: '/skills/writing' }] : [], mcpInventory: [{ name: 'CLI externe', external: true, tools: [{ name: 'read' }] }],
        appliedConfig: data?.config.agent === 'claude' ? { ...data.config, permissionMode: 'manual' } : null,
        onConfigChange: settings.change, configError: settings.error?.message, onConfigRetry: settings.retry,
        onSend: async (text) => { await settings.flush(); await api.post(`/api/conversations/${id}/messages`, { text }) },
        onInterrupt: () => {},
      })
    }
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null, React.createElement(Harness)))))
  })
  await page.getByRole('button', { name: 'Modèle et effort : Modèle Alpha · Élevé', exact: true }).waitFor()
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
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 667, height: 375 }]) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 700, isMobile: viewport.width < 700, locale: 'fr-FR', serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const stored = structuredClone(initial)
    // Account settings, including pinned bar: protocol default initially.
    const account = { agentDefaults: {}, collapsedProjects: [], projectsDir: null, appearance: null, notifications: {}, composerLayout: { claude: ['model', 'effort'], codex: ['model', 'effort'], opencode: [], grok: [] } }
    const layouts = []
    const patches = []
    const messages = []
    let hold = null
    let failNext = false
    let catalogRefreshes = 0
    let active = 0
    let maxActive = 0
    await page.route('**/__composer_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="fr"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main class="app-layer" style="display:flex;flex-direction:column;justify-content:flex-end"><div id="check"></div></main></body></html>' }))
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const id = path.split('/')[3]
      if (path.endsWith('/models')) {
        // Refreshing bypasses the server cache and may reveal a model the plan unlocked.
        const refreshed = new URL(request.url()).searchParams.get('refresh') === '1'
        if (refreshed) catalogRefreshes += 1
        const listed = refreshed ? [...models, { ...models[0], value: 'gamma', displayName: 'Modèle Gamma', description: 'Nouveau modèle', hint: null, isDefault: false }] : models
        return route.fulfill({ json: { models: listed, modes: id === 'codex' ? [{ mode: 'default', label: 'Standard' }, { mode: 'plan', label: 'Plan' }] : [], account: null, fetchedAt: Date.now() } })
      }
      if (path === '/api/me/settings') {
        if (request.method() === 'PATCH') { account.composerLayout = request.postDataJSON().composerLayout; layouts.push(account.composerLayout) }
        return route.fulfill({ json: account })
      }
      if (path === '/api/conversations') return route.fulfill({ json: [] })
      if (path === '/api/mcp/servers') return route.fulfill({ json: { servers: [{ id: 'docs', name: 'Documentation', enabled: true }], sillageServer: true } })
      if (path.endsWith('/messages')) {
        messages.push({ text: request.postDataJSON().text, config: structuredClone(stored[id]) })
        return route.fulfill({ json: { ok: true } })
      }
      if (path.startsWith('/api/conversations/')) {
        if (request.method() === 'GET') return route.fulfill({ json: { id, config: stored[id] } })
        if (request.method() === 'PATCH') {
          const config = request.postDataJSON().config
          patches.push(config)
          active++
          maxActive = Math.max(maxActive, active)
          if (hold) { const gate = hold; hold = null; await gate }
          active--
          if (failNext) { failNext = false; return route.fulfill({ status: 500, json: { error: { code: 'test', message: 'Erreur simulée' } } }) }
          stored[id] = config
          return route.fulfill({ json: { ok: true } })
        }
      }
      return route.fulfill({ json: {} })
    })
    await mount(page)
    const field = page.getByPlaceholder(/^Écris ton message/)
    // Phone: below 480 px, only model·effort chip, opening complete sheet;
    // no separate settings button or pins.
    const narrow = viewport.width < 500
    const touch = viewport.width < 700
    const full = page.getByRole('button', { name: /^Réglages de la conversation,/ })
    const chip = () => page.getByRole('button', { name: /^(Modèle et effort|Modèle) :/ })
    const dialog = page.getByRole('dialog')
    const openAll = async () => { await (narrow ? chip() : full).click(); await dialog.waitFor() }
    // Removed safeguards are indicated on panel button, or chip on phones.
    const status = () => narrow ? chip() : full
    // Panel is a list: one row per setting, opening its options and returning
    // after selection.
    const row = (setting) => dialog.getByRole('button', { name: new RegExp(`^${setting} :`) })
    const slider = () => dialog.getByRole('slider', { name: 'Effort de réflexion', exact: true })
    const chooseEffort = async (label) => {
      const index = efforts.findIndex((item) => item.label === label)
      await slider().fill(String(index))
      assert.equal(await slider().getAttribute('aria-valuetext'), label)
    }
    const pick = async (setting, option) => {
      if (setting === 'Effort de réflexion') {
        if (!narrow) await row(setting).click()
        await chooseEffort(option)
        if (!narrow) await back()
        return
      }
      // Phone: model/effort expanded at sheet top.
      if (narrow && (setting === 'Modèle' || setting === 'Effort de réflexion')) {
        await dialog.getByRole('radio', { name: option, exact: typeof option === 'string' }).click()
        return
      }
      await row(setting).click()
      await dialog.getByRole('radio', { name: option, exact: typeof option === 'string' }).click()
      await row(setting).waitFor()
    }
    const mcpView = async () => { await dialog.getByRole('button', { name: 'Serveurs MCP', exact: true }).click(); await dialog.locator('[data-settings-heading]', { hasText: 'Serveurs MCP' }).waitFor() }
    const back = async () => { await dialog.getByRole('button', { name: 'Retour', exact: true }).click(); await dialog.locator('[data-settings-heading]', { hasText: 'Réglages de la conversation' }).waitFor() }
    const close = async () => { await page.getByRole('button', { name: 'Terminé', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }) }
    // 32 px for mouse, 44 for touch; phone looks 36 but targets 44 through invisible
    // margin, checked by tapping just above button.
    for (const button of narrow ? [chip()] : [chip(), full]) {
      const bounds = await button.boundingBox()
      assert.ok(bounds.height >= (narrow ? 36 : touch ? 44 : 32), `${viewport.width}: ${bounds.height}`)
      if (narrow) {
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), { x: bounds.x + bounds.width / 2, y: bounds.y - 3 })
        assert.match(hit ?? '', /^Modèle et effort/, 'The touch target extends past the visible chip')
      }
    }
    if (narrow) {
      // Microphone replaces Send while field is empty.
      assert.equal(await page.getByRole('button', { name: 'Envoyer le message', exact: true }).isVisible(), false)
      assert.equal(await page.getByRole('button', { name: /^Dicter/ }).count(), 1)
    }

    await field.fill('Brouillon conservé')
    await field.evaluate((node) => node.setSelectionRange(3, 9))
    let release
    hold = new Promise((resolve) => { release = resolve })
    if (narrow) {
      assert.equal(await page.getByRole('button', { name: /^Dicter/ }).count(), 0, 'Typed text swaps the mic for send')
      await openAll()
      await dialog.getByRole('radio', { name: /^Modèle Beta/ }).click()
      // Sheet is modal: rest of page hidden while open, so fallback effort is read
      // in the sheet.
      assert.equal(await dialog.getByRole('radio', { name: /^Modèle Beta/ }).getAttribute('aria-checked'), 'true')
      assert.equal(await slider().getAttribute('aria-valuetext'), 'Moyen', 'Effort falls back immediately')
      await chooseEffort('Faible')
      await close()
      assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA')
    } else {
      // Selecting model keeps menu open; effort immediately falls back to a supported
      // level. The slider stays open until explicitly closed.
      await chip().click()
      await page.getByRole('radio', { name: /^Modèle Beta/ }).click()
      // Touch menu is a modal sheet hiding chip: read fallback effort inside sheet.
      if (touch) assert.equal(await slider().getAttribute('aria-valuetext'), 'Moyen')
      else await page.getByRole('button', { name: 'Modèle et effort : Modèle Beta · Moyen', exact: true }).waitFor()
      assert.equal(await dialog.isVisible(), true, 'Picking a model keeps the menu open')
      await chooseEffort('Faible')
      await page.getByRole('button', { name: 'Fermer', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA')
    }
    await page.getByRole('button', { name: 'Modèle et effort : Modèle Beta · Faible', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click()
    assert.equal(messages.length, 0, 'Sending waits for the pending settings')
    release()
    await page.waitForResponse((response) => response.url().endsWith('/messages'))
    assert.equal(maxActive, 1, 'Config writes are serialized')
    assert.equal(messages[0].config.model, 'beta')
    assert.equal(messages[0].config.reasoningEffort, 'low')
    assert.equal(patches[1].model, 'beta', 'The second edit includes the first')

    await field.fill('Encore un brouillon')
    const compactHeight = (await page.locator('form').boundingBox()).height
    await openAll()
    // List fits without scrolling: the purpose of two-level view.
    if (!narrow) assert.equal(await dialog.locator('.overflow-y-auto').evaluate((node) => node.scrollHeight <= node.clientHeight + 1), viewport.height >= 600, 'The settings list fits without scrolling')
    // Phone: no pinning or sorting.
    if (narrow) assert.equal(await dialog.getByRole('button', { name: /^Épingler/ }).count(), 0)
    await pick('Modèle', /^Modèle Alpha/)
    await pick('Effort de réflexion', 'Élevé')
    await pick('Mode', 'Plan')
    await pick('Bac à sable', /^Accès total/)
    await pick('Approbations', /^Jamais/)
    await mcpView()
    await page.getByRole('switch', { name: 'Documentation', exact: true }).click()
    assert.equal(await page.getByRole('switch', { name: 'CLI externe' }).count(), 0)
    await back()
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Serveurs MCP', 'Back returns focus to the row')
    const panelBounds = await dialog.boundingBox()
    assert.ok(panelBounds.y >= 0 && panelBounds.y + panelBounds.height <= viewport.height + 1)
    await close()
    assert.equal(await field.inputValue(), 'Encore un brouillon')
    await page.evaluate(() => window.settings.flush())
    assert.equal(stored.codex.collaborationMode, 'plan')
    assert.equal(stored.codex.askForApproval, 'never')
    assert.deepEqual(stored.codex.mcpServers, ['docs'])
    assert.match(await status().getAttribute('aria-label'), /Accès total/)
    if (viewport.width >= 700) {
      await full.hover()
      await page.getByRole('tooltip').waitFor()
      assert.match(await page.getByRole('tooltip').textContent(), /Plan.*Approbations : Jamais.*Accès total/)
      await page.keyboard.press('Escape')
      await page.mouse.move(0, 0)
    }
    assert.equal((await page.locator('form').boundingBox()).height, compactHeight, 'Permission indicators do not add a row')

    failNext = true
    if (narrow) {
      await openAll()
      await chooseEffort('Moyen')
      await dialog.getByRole('alert').waitFor()
      await close()
    } else {
      await chip().click()
      await chooseEffort('Moyen')
      await page.getByRole('button', { name: 'Fermer', exact: true }).click()
    }
    await page.getByRole('alert').filter({ hasText: 'Les réglages' }).waitFor()
    assert.equal(await field.inputValue(), 'Encore un brouillon')
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('textarea').value === 'Encore un brouillon')
    assert.equal(messages.length, 1, 'An unsaved configuration must not be used to send')
    await page.getByRole('button', { name: 'Réessayer', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Les réglages' }).waitFor({ state: 'hidden' })
    await page.evaluate(() => window.settings.flush())
    assert.equal(stored.codex.reasoningEffort, 'medium')

    await openAll()
    failNext = true
    await pick('Effort de réflexion', 'Faible')
    await dialog.getByRole('alert').waitFor()
    await dialog.getByRole('button', { name: 'Réessayer', exact: true }).click()
    await dialog.getByRole('alert').waitFor({ state: 'hidden' })
    assert.equal(await dialog.isVisible(), true, 'Retry does not leave the complete panel')
    await close()
    await page.evaluate(() => window.settings.flush())
    // Radix restores panel-button focus one frame after closing: focusing earlier
    // would send next Enter to full panel.
    await delay(100)

    if (narrow) {
      await openAll()
      await dialog.getByRole('radio', { name: /^Sans réflexion/ }).click()
      await close()
    } else {
      // Keyboard: menu opens on selected model, End reaches last, Enter selects;
      // without effort levels, section disappears and Escape closes.
      await chip().focus()
      await page.keyboard.press('Enter')
      await dialog.waitFor()
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await dialog.getByRole('radiogroup', { name: 'Effort de réflexion' }).waitFor({ state: 'detached' })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Modèle : Sans réflexion', exact: true }).waitFor()
    }
    assert.equal(await field.inputValue(), 'Encore un brouillon')
    await page.evaluate(() => window.settings.flush())

    // Real catalogs have about twelve models: effort must stay visible without
    // scrolling below independently scrolling model list.
    await page.evaluate(async () => {
      // The query key carries the account, null for the CLI login.
      const key = ['agents', 'codex', 'models', null]
      window.configBackup = window.settings.config
      window.settings.change({ ...window.settings.config, model: 'alpha', reasoningEffort: 'high' })
      await window.settings.flush()
      window.longCatalogBackup = window.client.getQueryData(key)
      const catalog = window.longCatalogBackup
      window.client.setQueryData(key, {
        ...catalog,
        models: [...catalog.models, ...Array.from({ length: 12 }, (_, i) => ({ ...catalog.models[0], value: `long-${i}`, displayName: `Modèle long ${i}`, description: 'Une description assez longue pour tenir sur plusieurs lignes si on la laissait faire', isDefault: false }))],
      })
    })
    await (narrow ? openAll() : chip().click())
    await dialog.waitFor()
    const effortGroup = slider()
    const track = await slider().boundingBox()
    if (touch) await page.touchscreen.tap(track.x + 12, track.y + track.height / 2)
    else await page.mouse.click(track.x + 12, track.y + track.height / 2)
    assert.equal(await slider().getAttribute('aria-valuetext'), 'Faible')
    await slider().focus()
    await slider().press('Home')
    assert.equal(await slider().getAttribute('aria-valuetext'), 'Faible')
    await slider().press('End')
    assert.equal(await slider().getAttribute('aria-valuetext'), 'Très élevé')
    await slider().press('ArrowLeft')
    assert.equal(await slider().getAttribute('aria-valuetext'), 'Élevé')
    // The thumb follows a fractional position while only the released stop is saved.
    const dragTrack = await slider().boundingBox()
    const dragY = dragTrack.y + dragTrack.height / 2
    const dragX = (level) => dragTrack.x + 12 + (dragTrack.width - 24) * level / 3
    const cdp = touch ? await context.newCDPSession(page) : null
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: dragX(2), y: dragY }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: dragX(1.4), y: dragY }] })
    } else {
      await page.mouse.move(dragX(2), dragY)
      await page.mouse.down()
      await page.mouse.move(dragX(1.4), dragY, { steps: 5 })
    }
    const duringDrag = Number(await slider().inputValue())
    assert.ok(duringDrag > 1.2 && duringDrag < 1.6, 'Dragging is continuous between stops')
    assert.equal(await page.evaluate(() => window.settings.config.reasoningEffort), 'high', 'Dragging does not persist intermediate levels')
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    else await page.mouse.up()
    assert.equal(await slider().inputValue(), '1', 'Release snaps to the nearest stop')
    assert.equal(await page.evaluate(() => window.settings.config.reasoningEffort), 'medium')
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: dragX(1), y: dragY }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: dragX(2.6), y: dragY }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
      assert.equal(await slider().inputValue(), '1', 'Cancelled gestures restore the saved stop')
      assert.equal(await page.evaluate(() => window.settings.config.reasoningEffort), 'medium')
      await cdp.detach()
    }
    await slider().press('ArrowRight')
    await slider().evaluate((node) => node.blur())
    await page.screenshot({ path: `/var/tmp/effort-slider-${viewport.width}.png` })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.screenshot({ path: `/var/tmp/effort-slider-dark-${viewport.width}.png` })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    const [effortBox, dialogBox] = [await effortGroup.boundingBox(), await dialog.boundingBox()]
    assert.ok(effortBox.y >= dialogBox.y && effortBox.y + effortBox.height <= dialogBox.y + dialogBox.height + 1, `${viewport.width}: effort visible without scrolling`)
    if (!narrow) {
      assert.equal(await dialog.locator('.overflow-y-auto').first().evaluate((node) => node.scrollHeight > node.clientHeight), true, 'The model list scrolls on its own')
      await page.keyboard.press('Escape')
    } else await close()
    await dialog.waitFor({ state: 'hidden' })
    await page.evaluate(async () => {
      window.client.setQueryData(['agents', 'codex', 'models', null], window.longCatalogBackup)
      window.settings.change(window.configBackup)
      await window.settings.flush()
    })

    // The model panel rereads the catalog from the CLI: a login or plan change must not wait an hour of cache.
    await (narrow ? openAll() : chip().click())
    await dialog.waitFor()
    // Phones list the models inline with their own refresh button; a long catalog hides them behind a row.
    if (narrow && await dialog.getByRole('button', { name: /^Modèle :/ }).count() > 0) await dialog.getByRole('button', { name: /^Modèle :/ }).first().click()
    assert.equal(await dialog.getByRole('radio', { name: 'Modèle Gamma Nouveau modèle', exact: true }).count(), 0)
    await dialog.getByRole('button', { name: 'Recharger Modèle depuis le CLI', exact: true }).click()
    await dialog.getByRole('radio', { name: 'Modèle Gamma Nouveau modèle', exact: true }).waitFor()
    assert.equal(catalogRefreshes, 1, 'The button requests the list past the server cache')
    await page.evaluate(() => window.client.setQueryData(['agents', 'codex', 'models', null], window.longCatalogBackup))
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await delay(100)

    if (viewport.width === 1440) {
      // Long catalog, saved out-of-catalog value, granular policy.
      await page.evaluate(async () => {
        const catalog = window.client.getQueryData(['agents', 'codex', 'models', null])
        window.client.setQueryData(['agents', 'codex', 'models', null], {
          ...catalog,
          models: [...catalog.models, ...Array.from({ length: 10 }, (_, i) => ({ ...catalog.models[0], value: `archive-${i}`, displayName: `Archive ${i}`, isDefault: false }))],
        })
        window.settings.change({ ...window.settings.config, model: 'saved-model', askForApproval: { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } } })
        await window.settings.flush()
      })
      await page.getByRole('button', { name: /^(Modèle et effort|Modèle) : saved-model/ }).waitFor()
      await chip().click()
      await page.getByRole('searchbox', { name: 'Rechercher un modèle', exact: true }).fill('Archive 9')
      assert.equal(await page.getByRole('radiogroup', { name: 'Modèle', exact: true }).getByRole('radio').count(), 1)
      await page.keyboard.press('Escape')
      await openAll()
      await row('Approbations').click()
      const approval = page.getByRole('radiogroup', { name: 'Approbations', exact: true })
      assert.equal(await approval.getByRole('radio', { name: /^Granulaire/ }).isDisabled(), true)
      assert.equal(await approval.getByRole('radio', { name: /^Défaut du CLI/ }).getAttribute('tabindex'), '0')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      // At phone width, chip opens sheet.
      await page.setViewportSize({ width: 390, height: 844 })
      await full.waitFor({ state: 'detached' })
      await chip().click()
      await page.getByRole('dialog', { name: 'Réglages de la conversation', exact: true }).waitFor()
      for (let i = 0; i < 18; i++) {
        await page.keyboard.press('Tab')
        assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true)
      }
      // Keyboard shrinks visual viewport without necessarily changing 100dvh.
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--sg-app-height', '420px')
        document.documentElement.style.setProperty('--sg-viewport-top', '30px')
      })
      const keyboardBounds = await dialog.boundingBox()
      assert.ok(keyboardBounds.y >= 30 && keyboardBounds.y + keyboardBounds.height <= 451)
      await page.evaluate(() => {
        document.documentElement.style.removeProperty('--sg-app-height')
        document.documentElement.style.removeProperty('--sg-viewport-top')
      })
      await close()
      await page.setViewportSize(viewport)
      await full.waitFor()

      hold = new Promise((resolve) => { release = resolve })
      await openAll()
      await pick('Approbations', /^Sur demande/)
      await close()
      await page.evaluate(() => window.setConversation('claude'))
      await page.getByRole('button', { name: 'Modèle et effort : Modèle Alpha · Élevé', exact: true }).waitFor()
      release()
      await page.waitForFunction(() => window.client.getQueryData(['conversation', 'codex'])?.config.askForApproval === 'on-request')
      assert.equal(await page.evaluate(() => window.settings.config.agent), 'claude', 'A late write belongs to its conversation')
    }

    await page.evaluate(() => window.setConversation('claude'))
    await chip().waitFor()
    await openAll()
    await pick('Permissions', /^Tout autoriser/)
    await dialog.getByText('En vigueur : Demander', { exact: true }).waitFor()
    await mcpView()
    await page.getByRole('switch', { name: /^N'utiliser que les serveurs/ }).click()
    assert.equal(await page.getByRole('switch', { name: /^Mémoire et coordination/ }).isDisabled(), true)
    await close()
    await page.evaluate(() => window.settings.flush())
    assert.equal(stored.claude.strictMcp, true)
    assert.match(await status().getAttribute('aria-label'), /Tout autoriser/)
    if (viewport.width >= 700) {
      await full.hover()
      await page.getByRole('tooltip').waitFor()
      assert.match(await page.getByRole('tooltip').textContent(), /Tout autoriser/)
      await page.keyboard.press('Escape')
      await page.mouse.move(0, 0)
    }

    if (narrow) {
      // Phone shows no pinned bar: model·effort chip stays alone.
      account.composerLayout = { ...account.composerLayout, claude: ['ultracode', 'permission'] }
      await page.evaluate(() => window.client.refetchQueries({ queryKey: ['user-settings'] }))
      await page.waitForFunction(() => window.client.getQueryData(['user-settings'])?.composerLayout.claude.length === 2)
      assert.equal(await page.getByRole('switch', { name: /^Ultracode :/ }).count(), 0)
      assert.equal(await page.getByRole('button', { name: /^Permissions :/ }).count(), 0)
    } else {
      // Pin through panel: toggle and chip appear beside model·effort; list saves
      // to account after removing `model`/`effort` keys saved by early versions.
      await openAll()
      assert.equal(await dialog.getByRole('button', { name: /^Épingler (Modèle|Effort)/ }).count(), 0, 'Model and effort are always there')
      await dialog.getByRole('button', { name: 'Épingler Ultracode sous le composeur', exact: true }).click()
      await dialog.getByRole('button', { name: 'Épingler Permissions sous le composeur', exact: true }).click()
      await close()
      const ultracode = page.getByRole('switch', { name: /^Ultracode :/ })
      await ultracode.waitFor()
      assert.equal(await ultracode.getAttribute('aria-checked'), 'false')
      await page.getByRole('button', { name: /^Permissions :/ }).waitFor()
      assert.deepEqual(layouts.at(-1).claude, ['ultracode', 'permission'])

      // Reorder through keyboard handle, then mouse when both handles fit onscreen;
      // bar follows.
      await openAll()
      await dialog.getByRole('button', { name: 'Déplacer Permissions', exact: true }).focus()
      // dnd-kit measures rows between keypresses: without pause, movement starts
      // before starting position is known.
      for (const key of ['Space', 'ArrowUp', 'Space']) { await page.keyboard.press(key); await delay(150) }
      await delay(250)
      assert.deepEqual(layouts.at(-1).claude, ['permission', 'ultracode'])
      const ultracodeHandle = dialog.getByRole('button', { name: 'Déplacer Ultracode', exact: true })
      if (viewport.height >= 600) {
        const grip = await ultracodeHandle.boundingBox()
        const target = await dialog.getByRole('button', { name: 'Déplacer Permissions', exact: true }).boundingBox()
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
        await page.mouse.down()
        await page.mouse.move(grip.x + grip.width / 2, grip.y - 10, { steps: 4 })
        await page.mouse.move(target.x + target.width / 2, target.y + 4, { steps: 8 })
        // Target is calculated next frame: releasing immediately would miss it.
        await delay(150)
        await page.mouse.up()
      } else {
        // Short sheet scrolls, so handles do not fit onscreen together: perform same
        // move by keyboard.
        await ultracodeHandle.focus()
        for (const key of ['Space', 'ArrowUp', 'Space']) { await page.keyboard.press(key); await delay(150) }
      }
      await delay(250)
      assert.deepEqual(layouts.at(-1).claude, ['ultracode', 'permission'])
      await close()
      const chips = await page.locator('form [aria-label*=" : "]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label').split(' :')[0]))
      assert.deepEqual(chips.slice(0, 3), ['Modèle et effort', 'Ultracode', 'Permissions'])
      await ultracode.click()
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label^="Ultracode :"]').getAttribute('aria-checked') === 'true')
      await page.evaluate(() => window.settings.flush())
      assert.equal(stored.claude.ultracode, true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Pinned chips do not overflow')
      // Everything fits one line: bar need not wrap.
      const [chipBox, sendBox] = [await chip().boundingBox(), await page.getByRole('button', { name: /^Réglages de la conversation,/ }).boundingBox()]
      // Mouse fits one line; 44 px touch targets push settings onto their own line,
      // the intended fallback.
      assert.equal(Math.abs(chipBox.y + chipBox.height / 2 - (sendBox.y + sendBox.height / 2)) < 4, !touch, 'One line with the mouse, folded with touch targets')
      await openAll()
      await dialog.getByRole('button', { name: 'Retirer Ultracode du composeur', exact: true }).click()
      await close()
      await ultracode.waitFor({ state: 'hidden' })
      assert.deepEqual(layouts.at(-1).claude, ['permission'])
    }

    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    // The discoverable panel uses the same live catalogs and preserves unsent text and selection.
    const insert = page.getByRole('button', { name: 'Insérer — aides de saisie', exact: true })
    await insert.click()
    const help = page.getByRole('dialog', { name: 'Aides de saisie', exact: true })
    await help.waitFor()
    assert.equal(await help.getByRole('button', { name: 'Commandes et skills', exact: true }).count(), 0)
    await help.getByRole('button', { name: 'Fermer', exact: true }).click()
    await page.evaluate(() => window.setCatalog(true))
    const beforeMessages = messages.length
    await field.fill('Texte conservé')
    await insert.click()
    await help.getByRole('button', { name: 'Commandes et skills', exact: true }).click()
    const commands = page.getByRole('listbox', { name: 'Commandes', exact: true })
    await commands.waitFor()
    assert.equal(await field.inputValue(), '/Texte conservé')
    await field.press('Tab')
    assert.equal(await field.inputValue(), '/review Texte conservé')
    await field.fill('Avant remplacer après')
    await field.evaluate(node => node.setSelectionRange(6, 15))
    await insert.click()
    await help.getByRole('button', { name: 'Skill', exact: true }).click()
    await page.getByRole('listbox', { name: 'Compétences', exact: true }).waitFor()
    assert.equal(await field.inputValue(), 'Avant $ après')
    await field.press('Tab')
    assert.equal(await field.inputValue(), 'Avant $writing  après')
    assert.equal(messages.length, beforeMessages, 'Insertion never sends or executes a command')
    await insert.click()
    await help.getByRole('button', { name: 'Fermer', exact: true }).click()
    assert.equal(await field.inputValue(), 'Avant $writing  après', 'Dismissing help preserves the draft')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.evaluate(() => window.setReadOnly(true))
    await page.waitForFunction(() => document.querySelector('button[aria-label^="Modèle"]').disabled)
    assert.equal(await insert.isDisabled(), true)
    assert.equal(await chip().isDisabled(), true)
    if (!narrow) assert.equal(await full.isDisabled(), true)
    assert.deepEqual(errors, [])
    console.log(`OK ${viewport.width}×${viewport.height}: quick choices, ordered saves, send waits, retry, draft, Claude/Codex, MCP, pinned chips, reorder, bounds`)
    await context.close()
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  if (vite.exitCode === null) await once(vite, 'exit')
}
