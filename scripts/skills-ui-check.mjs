import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Vrais composants ; les sources simulées permettent un conflit reproductible, sans toucher aux skills installés.
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

async function mount(page) {
  await page.goto(`${origin}/__skills_check`)
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
    const hookSource = await (await fetch('/src/lib/skill-library.ts')).text()
    const { QueryClient, QueryClientProvider } = await import(hookSource.match(/from ["']([^"']*tanstack[^"']+)["']/)[1])
    const source = await (await fetch('/src/components/chat/SkillsControl.tsx')).text()
    const { MemoryRouter } = await import(source.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1])
    const { SkillsControl } = await import('/src/components/chat/SkillsControl.tsx')
    const { AddSkillMenu } = await import('/src/components/skills/AddSkillMenu.tsx')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const commands = Array.from({ length: 24 }, (_, i) => ({ name: `commande-${i}`, description: 'Une description de commande très longue. '.repeat(30) }))
    const content = React.createElement('div', { className: 'p-6 flex gap-6' },
      React.createElement(SkillsControl, { config: { agent: 'claude', skillLibrary: true }, commands, skills: [], inputRef: { current: null } }),
      React.createElement(AddSkillMenu, { scope: 'global', projectId: null }))
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null, content))))
  })
}

try {
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) break
    if (vite.exitCode !== null) throw new Error(diagnostics)
    await delay(100)
  }
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 700, isMobile: viewport.width < 700, serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const source = { id: 'source-a', name: 'Équipe design', enabled: true, lastCommit: '123456abcdef' }
    const catalog = Array.from({ length: 25 }, (_, i) => ({ name: `design-${String(i).padStart(2, '0')}`, path: `skills/design-${i}`, description: 'Concevoir des interfaces lisibles et soignées. '.repeat(15), problem: null, scripts: false, installed: [] }))
    const installed = []
    const attempts = []
    await page.route('**/__skills_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="check"></div></body></html>' }))
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      const send = (json, status = 200) => route.fulfill({ status, json })
      if (url.pathname === '/api/auth/me') return send({ id: 'admin', isAdmin: true })
      if (url.pathname === '/api/projects') return send([])
      if (url.pathname === '/api/skill-sources') return send({ sources: [source, { ...source, id: 'source-b', name: 'Autre équipe' }] })
      if (url.pathname.endsWith('/catalog')) return send({ source, skills: catalog })
      if (url.pathname.endsWith('/preview')) return send({ main: '---\nname: design\n---\n' + 'Instructions détaillées.\n'.repeat(80), files: ['SKILL.md'], commit: source.lastCommit })
      if (url.pathname.endsWith('/install')) {
        const body = route.request().postDataJSON()
        attempts.push(body)
        await delay(80)
        if (body.path === 'skills/design-1' && !body.name) return send({ error: { code: 'skill_name_taken', message: 'Nom déjà pris', params: { name: 'design-01' } } }, 409)
        const skill = catalog.find((item) => item.path === body.path)
        skill.installed.push({ skillId: skill.path, scope: body.scope, projectId: body.projectId, name: body.name ?? skill.name, updateAvailable: false })
        installed.push(body.path)
        return send({ id: skill.path, name: body.name ?? skill.name })
      }
      if (url.pathname === '/api/skill-library') return send({ enabled: true, skills: catalog.map((item) => ({ ...item, id: item.path, scope: 'global', enabled: true })) })
      return send({})
    })
    await mount(page)
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    const inventory = page.getByRole('dialog', { name: 'Skills', exact: true })
    await inventory.waitFor()
    const box = await inventory.boundingBox()
    if (viewport.width > 700) assert.ok(box.width >= 800)
    const manage = inventory.getByRole('link', { name: 'Gérer la bibliothèque' })
    assert.ok(await manage.isVisible())
    const summary = inventory.locator('summary').first()
    await summary.waitFor()
    assert.ok((await summary.boundingBox()).height < 110)
    await summary.click()
    assert.equal(await inventory.locator('details').first().getAttribute('open'), '')
    await inventory.getByRole('button', { name: /Dans la session/ }).click()
    await inventory.getByText('commande-23', { exact: true }).scrollIntoViewIfNeeded()
    assert.ok(await manage.isVisible())
    await page.screenshot({ path: `/tmp/sillage-skills-composer-${viewport.width}.png` })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Ajouter un skill', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Depuis un catalogue…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Catalogues de skills' })
    await dialog.getByRole('checkbox', { name: 'Sélectionner design-00', exact: true }).waitFor()
    await dialog.getByRole('checkbox', { name: 'Sélectionner design-00', exact: true }).check()
    await dialog.getByRole('combobox', { name: 'Source', exact: true }).click()
    await page.getByRole('option', { name: /Autre équipe/ }).click()
    assert.equal(await dialog.getByRole('checkbox', { name: 'Sélectionner design-00', exact: true }).isChecked(), false)
    await dialog.getByRole('combobox', { name: 'Source', exact: true }).click()
    await page.getByRole('option', { name: /Équipe design/ }).click()
    const filter = dialog.getByRole('textbox', { name: 'Filtrer les skills' })
    await filter.fill('design-0')
    await dialog.getByRole('button', { name: 'Tout sélectionner dans les résultats' }).click()
    await filter.fill('design-24')
    await dialog.getByRole('checkbox', { name: 'Sélectionner design-24', exact: true }).check()
    await filter.fill('')
    await page.screenshot({ path: `/tmp/sillage-skills-catalog-${viewport.width}.png` })
    await dialog.getByRole('button', { name: 'Installer la sélection (11)', exact: true }).click()
    await dialog.getByRole('button', { name: 'Installer la sélection (1)', exact: true }).waitFor()
    assert.equal(installed.length, 10)
    assert.equal(new Set(installed).size, 10)
    assert.equal(attempts.length, 11)
    assert.ok(await dialog.isVisible())
    assert.ok((await dialog.getByRole('alert').count()) > 0)
    // Un conflit peut être corrigé dans l'aperçu sans quitter la source ni réinstaller les succès.
    await dialog.getByRole('button').filter({ hasText: 'design-01' }).click()
    await dialog.getByRole('textbox', { name: 'Nom', exact: true }).fill('design-renamed')
    await dialog.getByRole('button', { name: 'Installer', exact: true }).click()
    await dialog.getByRole('button', { name: 'Installer la sélection (0)', exact: true }).waitFor()
    assert.equal(installed.length, 11)
    assert.equal(await dialog.getByRole('alert').count(), 0)
    if (viewport.width < 700) {
      await dialog.getByRole('button', { name: 'Retour aux skills', exact: true }).click()
      assert.ok(await dialog.getByRole('checkbox', { name: 'Sélectionner design-00', exact: true }).isDisabled())
    }
    assert.ok(await dialog.isVisible())
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('OK : inventaire compact, bibliothèque accessible, sélection filtrée persistante, installation groupée, conflit partiel et renommage ; ordinateur et téléphone.')
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  await once(vite, 'exit')
}
