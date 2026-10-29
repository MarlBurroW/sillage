import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Real components; simulated sources reproduce partial updates without touching installed skills.
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
    const { SkillUpdates } = await import('/src/components/skills/SkillUpdates.tsx')
    const { useSkillLibrary } = await import('/src/lib/skill-library.ts')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    function Harness() {
      const library = useSkillLibrary(null)
      return React.createElement('main', { className: 'mx-auto max-w-5xl p-4' }, React.createElement(SkillUpdates, { skills: library.data?.skills ?? [] }))
    }
    const content = React.createElement(Harness)
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
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 700, hasTouch: width < 700, serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const skills = ['alpha', 'beta', 'gamma', 'local', 'changed'].map((name) => ({
      id: name, name, scope: 'global', projectId: null, enabled: true, problem: null, compat: [],
      origin: { sourceId: name === 'beta' ? 'second' : 'team', sourceName: 'Équipe', path: name, commit: 'abcdef0' },
      updateAvailable: false, locallyModified: name === 'local', description: 'Description',
    }))
    let fail = true
    let refreshFail = true
    const applied = []
    const refreshed = []
    const patch = Array.from({ length: 20 }, (_, index) => {
      const lines = Array.from({ length: index === 10 ? 716 : 12 }, (_, n) => `+ligne ${n} ` + 'contenu '.repeat(30))
      return `diff --git a/file-${index}.md b/file-${index}.md\n--- a/file-${index}.md\n+++ b/file-${index}.md\n@@ -0,0 +1,${lines.length} @@\n${lines.join('\n')}\n`
    }).join('')
    await page.route('**/__skills_check', (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="check"></div></body></html>' }))
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      const send = (json, status = 200) => route.fulfill({ json, status })
      if (url.pathname === '/api/auth/me') return send({ id: 'admin', isAdmin: true })
      if (url.pathname === '/api/projects') return send([])
      if (url.pathname === '/api/skill-sources') return send({ sources: [{ id: 'team', name: 'Équipe', enabled: true }, { id: 'second', name: 'Autre source', enabled: true }, { id: 'unused', name: 'Sans skill installé', enabled: true }] })
      if (url.pathname.endsWith('/refresh')) {
        await delay(700)
        refreshed.push(url.pathname)
        if (url.pathname.includes('/second/') && refreshFail) return send({ error: { code: 'unknown', message: 'Source inaccessible' } }, 500)
        skills.filter((skill) => url.pathname.includes('/' + skill.origin.sourceId + '/')).forEach((skill) => { skill.updateAvailable = true })
        return send({ id: 'team', enabled: true })
      }
      if (url.pathname === '/api/skill-library') return send({ enabled: true, skills })
      const id = url.pathname.split('/')[3]
      const skill = skills.find((item) => item.id === id)
      if (url.pathname.endsWith('/update')) {
        await delay(500)
        if (route.request().method() === 'GET') return send({ skill, fromCommit: 'abcdef0', toCommit: '1234567', patch })
        if (id === 'beta' && fail) return send({ error: { code: 'unknown', message: 'Échec de mise à jour' } }, 500)
        applied.push(id)
        skill.updateAvailable = false
        skill.locallyModified = false
        return send(skill)
      }
      if (skill) {
        if (id === 'changed') skill.locallyModified = true
        return send(skill)
      }
      return send({})
    })
    await mount(page)
    await page.getByRole('button', { name: 'Rechercher les mises à jour', exact: true }).click()
    await page.getByRole('progressbar', { name: 'Vérification des sources…' }).waitFor()
    assert.equal(await page.getByRole('progressbar').getAttribute('max'), '2')
    await page.screenshot({ path: `/var/tmp/skills-loading-updates-${width}.png` })
    await page.getByText(/Autre source : Source inaccessible/).waitFor()
    assert.equal(refreshed.length, 2, 'Une récupération par source utilisée, aucune pour une source sans skill installé')
    refreshFail = false
    await page.getByRole('button', { name: 'Rechercher les mises à jour', exact: true }).click()
    await page.getByText('Mises à jour disponibles : 5.', { exact: true }).waitFor()
    assert.equal(refreshed.length, 4)
    const first = page.locator('li').filter({ has: page.getByText('alpha', { exact: true }) })
    await first.getByRole('button', { name: 'Voir les changements' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText('Comparaison des versions…', { exact: true }).waitFor()
    await dialog.locator('details').first().waitFor()
    assert.equal(await dialog.locator('details').count(), 20)
    const heights = await dialog.locator('details').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))
    assert.ok(heights.every((height) => height > 150), `Fichiers comprimés : ${heights}`)
    await dialog.locator('summary').last().scrollIntoViewIfNeeded()
    assert.ok(await dialog.getByRole('button', { name: 'Appliquer la mise à jour', exact: true }).isVisible())
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await dialog.locator('summary').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/skill-updates-diff-${width}.png` })
    await dialog.locator('summary').first().click()
    assert.equal(await dialog.locator('details').first().getAttribute('open'), null)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Tout sélectionner dans les résultats', exact: true }).click()
    assert.equal(await page.getByRole('checkbox', { name: 'Sélectionner local', exact: true }).isChecked(), false)
    await page.getByRole('button', { name: 'Mettre à jour la sélection (4)', exact: true }).click()
    await page.getByRole('progressbar', { name: 'Mise à jour des skills…' }).waitFor()
    assert.equal(await page.getByRole('progressbar').getAttribute('max'), '4')
    await page.getByText('Skills mis à jour : 2.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Mettre à jour la sélection (1)', exact: true }).waitFor()
    assert.deepEqual(applied, ['alpha', 'gamma'])
    assert.ok(await page.getByText(/changed : Ce skill a été modifié localement/).isVisible())
    fail = false
    assert.ok(await page.getByRole('checkbox', { name: 'Sélectionner changed', exact: true }).isDisabled())
    await page.getByRole('button', { name: 'Mettre à jour la sélection (1)', exact: true }).click()
    await page.getByText('Skills mis à jour : 1.', { exact: true }).waitFor()
    assert.deepEqual(applied, ['alpha', 'gamma', 'beta'])
    await page.screenshot({ path: `/tmp/skill-updates-list-${width}.png` })
    const local = page.locator('li').filter({ has: page.getByText('local', { exact: true }) })
    await local.getByRole('button', { name: 'Voir les changements' }).click()
    await dialog.getByRole('checkbox').waitFor()
    assert.ok(await dialog.getByRole('button', { name: 'Appliquer la mise à jour', exact: true }).isDisabled())
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Appliquer la mise à jour', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(applied, ['alpha', 'gamma', 'beta', 'local'])
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('OK : diff de 20 fichiers dont 716 lignes, défilement et repli, recherche groupée, succès partiels, reprise et modifications locales ; ordinateur et téléphone.')
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  await once(vite, 'exit')
}
