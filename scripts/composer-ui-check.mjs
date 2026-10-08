import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Vrai composer et vraie file de sauvegarde ; API simulée, aucun CLI lancé.
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
      useVisualViewport()
      const { data } = useConversation(id)
      const settings = useConversationConfig(data)
      window.setConversation = setId
      window.setReadOnly = setDisabled
      window.settings = settings
      if (!settings.config) return null
      return React.createElement(Composer, {
        key: id, config: settings.config, draftKey: `composer-test-${id}`, status: 'idle', disabled,
        commands: [], skills: [], mcpInventory: [{ name: 'CLI externe', external: true, tools: [{ name: 'read' }] }],
        appliedConfig: data?.config.agent === 'claude' ? { ...data.config, permissionMode: 'manual' } : null,
        onConfigChange: settings.change, configError: settings.error?.message, onConfigRetry: settings.retry,
        onSend: async (text) => { await settings.flush(); await api.post(`/api/conversations/${id}/messages`, { text }) },
        onInterrupt: () => {},
      })
    }
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null, React.createElement(Harness)))))
  })
  await page.getByRole('button', { name: 'Modèle : Modèle Alpha', exact: true }).waitFor()
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
    const patches = []
    const messages = []
    let hold = null
    let failNext = false
    let active = 0
    let maxActive = 0
    await page.route('**/__composer_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="fr"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main class="app-layer" style="display:flex;flex-direction:column;justify-content:flex-end"><div id="check"></div></main></body></html>' }))
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const id = path.split('/')[3]
      if (path.endsWith('/models')) return route.fulfill({ json: { models, modes: id === 'codex' ? [{ mode: 'default', label: 'Standard' }, { mode: 'plan', label: 'Plan' }] : [], account: null, fetchedAt: Date.now() } })
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
    const field = page.getByPlaceholder('Écris ton message...')
    const full = page.getByRole('button', { name: /^Réglages de la conversation,/ })
    const model = () => page.getByRole('button', { name: /^Modèle :/ })
    const effort = () => page.getByRole('button', { name: /^Effort de réflexion :/ })
    const dialog = page.getByRole('dialog')
    const openAll = async () => { await full.click(); await dialog.waitFor() }
    const close = async () => { await page.getByRole('button', { name: 'Terminé', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }) }
    for (const button of [model(), effort(), full]) {
      const bounds = await button.boundingBox()
      assert.ok(bounds.width >= 44 && bounds.height >= 44)
    }

    await field.fill('Brouillon conservé')
    await field.evaluate((node) => node.setSelectionRange(3, 9))
    let release
    hold = new Promise((resolve) => { release = resolve })
    await model().click()
    await page.getByRole('radio', { name: /^Modèle Beta/ }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Modèle : Modèle Beta', exact: true }).waitFor()
    assert.equal(await effort().getAttribute('aria-label'), 'Effort de réflexion : Moyen', 'Effort falls back immediately')
    if (viewport.width >= 700) {
      await page.waitForFunction(() => document.activeElement.tagName === 'TEXTAREA')
      assert.deepEqual(await field.evaluate((node) => [node.selectionStart, node.selectionEnd]), [3, 9])
    } else assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA')
    await effort().click()
    await page.getByRole('radio', { name: /^Faible/ }).click()
    await page.getByRole('button', { name: 'Effort de réflexion : Faible', exact: true }).waitFor()
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
    await page.getByRole('radio', { name: /^Modèle Alpha/ }).click()
    await page.getByRole('radio', { name: 'Élevé', exact: true }).click()
    await page.getByRole('radio', { name: 'Plan', exact: true }).click()
    await page.getByRole('radio', { name: /^Accès total/ }).click()
    await page.getByRole('radio', { name: /^Jamais/ }).click()
    await page.getByRole('switch', { name: 'Documentation', exact: true }).click()
    assert.equal(await dialog.isVisible(), true)
    assert.equal(await page.getByRole('switch', { name: 'CLI externe' }).count(), 0)
    const panelBounds = await dialog.boundingBox()
    assert.ok(panelBounds.y >= 0 && panelBounds.y + panelBounds.height <= viewport.height + 1)
    await close()
    assert.equal(await field.inputValue(), 'Encore un brouillon')
    await page.evaluate(() => window.settings.flush())
    assert.equal(stored.codex.collaborationMode, 'plan')
    assert.equal(stored.codex.askForApproval, 'never')
    assert.deepEqual(stored.codex.mcpServers, ['docs'])
    assert.match(await full.getAttribute('aria-label'), /Accès total/)
    if (viewport.width >= 700) {
      await full.hover()
      await page.getByRole('tooltip').waitFor()
      assert.match(await page.getByRole('tooltip').textContent(), /Plan.*Approbations : Jamais.*Accès total/)
      await page.keyboard.press('Escape')
      await page.mouse.move(0, 0)
    }
    assert.equal((await page.locator('form').boundingBox()).height, compactHeight, 'Permission indicators do not add a row')

    failNext = true
    await effort().click()
    await page.getByRole('radio', { name: /^Moyen/ }).click()
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
    await page.getByRole('radio', { name: 'Faible', exact: true }).click()
    await dialog.getByRole('alert').waitFor()
    await dialog.getByRole('button', { name: 'Réessayer', exact: true }).click()
    await dialog.getByRole('alert').waitFor({ state: 'hidden' })
    assert.equal(await dialog.isVisible(), true, 'Retry does not leave the complete panel')
    await close()
    await page.evaluate(() => window.settings.flush())

    await model().focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('End')
    assert.equal(await dialog.isVisible(), true)
    await page.keyboard.press('Enter')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await effort().count(), 0)
    assert.equal(await field.inputValue(), 'Encore un brouillon')
    await page.evaluate(() => window.settings.flush())

    if (viewport.width === 1440) {
      // Catalogue long, valeur enregistrée hors catalogue et politique granulaire.
      await page.evaluate(async () => {
        const catalog = window.client.getQueryData(['agents', 'codex', 'models'])
        window.client.setQueryData(['agents', 'codex', 'models'], {
          ...catalog,
          models: [...catalog.models, ...Array.from({ length: 10 }, (_, i) => ({ ...catalog.models[0], value: `archive-${i}`, displayName: `Archive ${i}`, isDefault: false }))],
        })
        window.settings.change({ ...window.settings.config, model: 'saved-model', askForApproval: { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } } })
        await window.settings.flush()
      })
      await page.getByRole('button', { name: 'Modèle : saved-model', exact: true }).waitFor()
      await model().click()
      await page.getByRole('searchbox', { name: 'Rechercher un modèle', exact: true }).fill('Archive 9')
      assert.equal(await page.getByRole('radio').count(), 1)
      await page.keyboard.press('Escape')
      await openAll()
      const approval = page.getByRole('radiogroup', { name: 'Approbations', exact: true })
      assert.equal(await approval.getByRole('radio', { name: /^Granulaire/ }).isDisabled(), true)
      assert.equal(await approval.getByRole('radio', { name: /^Défaut du CLI/ }).getAttribute('tabindex'), '0')
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('dialog', { name: 'Réglages de la conversation', exact: true }).waitFor()
      for (let i = 0; i < 18; i++) {
        await page.keyboard.press('Tab')
        assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true)
      }
      // Le clavier réduit le viewport visuel sans forcément modifier 100dvh.
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

      hold = new Promise((resolve) => { release = resolve })
      await openAll()
      await page.getByRole('radio', { name: /^Sur demande/ }).click()
      await close()
      await page.evaluate(() => window.setConversation('claude'))
      await page.getByRole('button', { name: 'Modèle : Modèle Alpha', exact: true }).waitFor()
      release()
      await page.waitForFunction(() => window.client.getQueryData(['conversation', 'codex'])?.config.askForApproval === 'on-request')
      assert.equal(await page.evaluate(() => window.settings.config.agent), 'claude', 'A late write belongs to its conversation')
    }

    await page.evaluate(() => window.setConversation('claude'))
    await model().waitFor()
    await openAll()
    await page.getByRole('radio', { name: /^Tout autoriser/ }).click()
    await page.getByText('En vigueur : Demander', { exact: true }).waitFor()
    await page.getByRole('switch', { name: /^N'utiliser que les serveurs/ }).click()
    assert.equal(await page.getByRole('switch', { name: /^Mémoire et coordination/ }).isDisabled(), true)
    await close()
    await page.evaluate(() => window.settings.flush())
    assert.equal(stored.claude.strictMcp, true)
    assert.match(await full.getAttribute('aria-label'), /Tout autoriser/)
    if (viewport.width >= 700) {
      await full.hover()
      await page.getByRole('tooltip').waitFor()
      assert.match(await page.getByRole('tooltip').textContent(), /Tout autoriser/)
      await page.keyboard.press('Escape')
      await page.mouse.move(0, 0)
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.evaluate(() => window.setReadOnly(true))
    await page.waitForFunction(() => document.querySelector('button[aria-label^="Modèle :"]').disabled)
    assert.equal(await model().isDisabled(), true)
    assert.equal(await full.isDisabled(), true)
    assert.deepEqual(errors, [])
    console.log(`OK ${viewport.width}×${viewport.height}: quick choices, ordered saves, send waits, retry, draft, Claude/Codex, MCP, bounds`)
    await context.close()
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  if (vite.exitCode === null) await once(vite, 'exit')
}
