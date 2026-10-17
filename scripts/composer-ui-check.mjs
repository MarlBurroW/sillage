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
  // `xhigh` : c'est lui qui rend Ultracode disponible, et donc épinglable.
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
    // Les réglages du compte, dont la barre épinglée : le défaut du protocole au départ.
    const account = { agentDefaults: {}, collapsedProjects: [], projectsDir: null, appearance: null, notifications: {}, composerLayout: { claude: ['model', 'effort'], codex: ['model', 'effort'], opencode: [], grok: [] } }
    const layouts = []
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
      if (path === '/api/me/settings') {
        if (request.method() === 'PATCH') { account.composerLayout = request.postDataJSON().composerLayout; layouts.push(account.composerLayout) }
        return route.fulfill({ json: account })
      }
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
    // Téléphone : la barre de moins de 480 px, puce modèle·effort seule, qui ouvre la
    // feuille complète ; pas de bouton de réglages à part ni d'épingles.
    const narrow = viewport.width < 500
    const touch = viewport.width < 700
    const full = page.getByRole('button', { name: /^Réglages de la conversation,/ })
    const chip = () => page.getByRole('button', { name: /^(Modèle et effort|Modèle) :/ })
    const dialog = page.getByRole('dialog')
    const openAll = async () => { await (narrow ? chip() : full).click(); await dialog.waitFor() }
    // Ce qui porte les garde-fous retirés : le bouton du panneau, ou la puce au téléphone.
    const status = () => narrow ? chip() : full
    // Le panneau est une liste : une ligne par réglage, qui s'ouvre sur ses options et y
    // revient après le choix.
    const row = (setting) => dialog.getByRole('button', { name: new RegExp(`^${setting} :`) })
    const pick = async (setting, option) => {
      // Au téléphone, modèle et effort sont dépliés en tête de la feuille.
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
    // 32 px à la souris, 44 au doigt ; au téléphone, 36 à l'œil et 44 au doigt grâce à
    // une marge invisible, vérifiée en touchant juste au-dessus du bouton.
    for (const button of narrow ? [chip()] : [chip(), full]) {
      const bounds = await button.boundingBox()
      assert.ok(bounds.height >= (narrow ? 36 : touch ? 44 : 32), `${viewport.width}: ${bounds.height}`)
      if (narrow) {
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), { x: bounds.x + bounds.width / 2, y: bounds.y - 3 })
        assert.match(hit ?? '', /^Modèle et effort/, 'The touch target extends past the visible chip')
      }
    }
    if (narrow) {
      // Le micro tient la place de l'envoi tant que le champ est vide.
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
      // La feuille est modale : le reste de la page est masqué tant qu'elle est ouverte,
      // l'effort retombé se lit donc dans la feuille.
      assert.equal(await dialog.getByRole('radio', { name: /^Modèle Beta/ }).getAttribute('aria-checked'), 'true')
      assert.equal(await dialog.getByRole('radio', { name: 'Moyen', exact: true }).getAttribute('aria-checked'), 'true', 'Effort falls back immediately')
      await dialog.getByRole('radio', { name: 'Faible', exact: true }).click()
      await close()
      assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA')
    } else {
      // Choisir un modèle laisse le menu ouvert, l'effort retombe aussitôt sur un niveau
      // du nouveau modèle ; choisir l'effort referme et rend la saisie.
      await chip().click()
      await page.getByRole('radio', { name: /^Modèle Beta/ }).click()
      // Au doigt, le menu est une feuille modale qui masque la puce : l'effort retombé
      // se lit alors dans la feuille.
      if (touch) assert.equal(await dialog.getByRole('radio', { name: 'Moyen', exact: true }).getAttribute('aria-checked'), 'true')
      else await page.getByRole('button', { name: 'Modèle et effort : Modèle Beta · Moyen', exact: true }).waitFor()
      assert.equal(await dialog.isVisible(), true, 'Picking a model keeps the menu open')
      await page.getByRole('radio', { name: 'Faible', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      if (!touch) {
        await page.waitForFunction(() => document.activeElement.tagName === 'TEXTAREA')
        assert.deepEqual(await field.evaluate((node) => [node.selectionStart, node.selectionEnd]), [3, 9])
      } else assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA')
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
    // La liste tient sans défiler : c'est tout l'objet de la vue en deux niveaux.
    if (!narrow) assert.equal(await dialog.locator('.overflow-y-auto').evaluate((node) => node.scrollHeight <= node.clientHeight + 1), viewport.height >= 600, 'The settings list fits without scrolling')
    // Au téléphone, rien ne s'épingle ni ne se trie.
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
      await dialog.getByRole('radio', { name: /^Moyen/ }).click()
      await dialog.getByRole('alert').waitFor()
      await close()
    } else {
      await chip().click()
      await page.getByRole('radio', { name: /^Moyen/ }).click()
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
    // Radix rend le focus au bouton du panneau une image après la fermeture : le poser
    // avant ferait atterrir l'Entrée suivante sur le panneau complet.
    await delay(100)

    if (narrow) {
      await openAll()
      await dialog.getByRole('radio', { name: /^Sans réflexion/ }).click()
      await close()
    } else {
      // Au clavier : le menu s'ouvre sur le modèle choisi, Fin va au dernier, Entrée le
      // prend ; sans niveaux d'effort, la section disparaît et Échap referme.
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
      // Passé en largeur de téléphone, la feuille s'ouvre depuis la puce.
      await page.setViewportSize({ width: 390, height: 844 })
      await full.waitFor({ state: 'detached' })
      await chip().click()
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
      // Au téléphone, une barre épinglée ne s'affiche pas : la puce modèle·effort reste seule.
      account.composerLayout = { ...account.composerLayout, claude: ['ultracode', 'permission'] }
      await page.evaluate(() => window.client.refetchQueries({ queryKey: ['user-settings'] }))
      await page.waitForFunction(() => window.client.getQueryData(['user-settings'])?.composerLayout.claude.length === 2)
      assert.equal(await page.getByRole('switch', { name: /^Ultracode :/ }).count(), 0)
      assert.equal(await page.getByRole('button', { name: /^Permissions :/ }).count(), 0)
    } else {
      // Épingler depuis le panneau : l'interrupteur et la puce apparaissent à côté de la
      // puce modèle·effort, et la liste part au compte, débarrassée des clés `model` et
      // `effort` qu'enregistraient les premières versions.
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

      // Réordonner au clavier depuis la poignée, puis à la souris quand les deux
      // poignées tiennent à l'écran ; la barre suit.
      await openAll()
      await dialog.getByRole('button', { name: 'Déplacer Permissions', exact: true }).focus()
      // dnd-kit mesure les lignes entre deux touches : sans pause, le déplacement part
      // avant que la position de départ soit connue.
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
        // La cible se calcule à l'image suivante : lâcher dans la foulée la manquerait.
        await delay(150)
        await page.mouse.up()
      } else {
        // Sur une feuille basse, la liste défile et les poignées ne tiennent pas
        // ensemble à l'écran : le même déplacement s'y fait au clavier.
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
      // Tout tient sur une ligne : la barre n'a pas à se replier.
      const [chipBox, sendBox] = [await chip().boundingBox(), await page.getByRole('button', { name: /^Réglages de la conversation,/ }).boundingBox()]
      // À la souris, tout tient sur une ligne ; au doigt, les cibles de 44 px font
      // passer les réglages sur leur ligne, et c'est le repli voulu.
      assert.equal(Math.abs(chipBox.y + chipBox.height / 2 - (sendBox.y + sendBox.height / 2)) < 4, !touch, 'One line with the mouse, folded with touch targets')
      await openAll()
      await dialog.getByRole('button', { name: 'Retirer Ultracode du composeur', exact: true }).click()
      await close()
      await ultracode.waitFor({ state: 'hidden' })
      assert.deepEqual(layouts.at(-1).claude, ['permission'])
    }

    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.evaluate(() => window.setReadOnly(true))
    await page.waitForFunction(() => document.querySelector('button[aria-label^="Modèle"]').disabled)
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
