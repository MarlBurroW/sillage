import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Real settings components with deterministic API failures; never writes to installed skills.
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

async function mount(page, component = 'settings') {
  await page.goto(`${origin}/__skills_navigation`)
  await page.evaluate(async (component) => {
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
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const { SkillLibrarySettingsPage } = await import('/src/routes/SkillLibrarySettingsPage.tsx')
    const { ProjectSkills } = await import('/src/components/skills/ProjectSkills.tsx')
    const { CatalogDialog } = await import('/src/components/skills/CatalogDialog.tsx')
    const child = component === 'project' ? React.createElement(ProjectSkills, { projectId: 'project-a', isOwner: true })
      : component === 'missing' ? React.createElement(CatalogDialog, { open: true, sourceId: 'gone', scope: 'global', projectId: null, onClose: () => {} })
      : React.createElement(SkillLibrarySettingsPage)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, null, React.createElement(TooltipProvider, null, child))))
  }, component)
}

const makeSource = (id, name, fetched = true) => ({
  id, name, url: `https://github.com/${name}.git`, ref: null, subpath: null, builtin: false, enabled: true,
  lastCommit: fetched ? '123456abcdef' : null, lastFetchedAt: Date.now(), lastError: null, skillCount: fetched ? 1 : null,
})
const makeSkill = (name, path = `skills/${name}`) => ({ name, path, description: 'Un skill pour vérifier les parcours.', problem: null, scripts: false, installed: [] })

try {
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) break
    if (vite.exitCode !== null) throw new Error(diagnostics)
    await delay(100)
  }
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const profile of ['server', 'desktop']) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 700, isMobile: viewport.width < 700, serviceWorkers: 'block' })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    const unexpected = []
    const requests = []
    let admin = true
    let directoryAvailable = true
    const failRefresh = new Set(['team/wanted', 'team/manual'])
    const sources = [makeSource('unrelated', 'team/unrelated'), makeSource('disabled', 'team/disabled')]
    sources[1].enabled = false
    const catalogs = new Map([
      ['team/unrelated', [makeSkill('local-one'), makeSkill('local-two')]],
      ['team/wanted', [makeSkill('wanted', 'nested/not-the-name')]],
      ['team/missing', [makeSkill('different-skill')]],
      ['team/ambiguous', [makeSkill('ambiguous', 'a/skill'), makeSkill('ambiguous', 'b/skill')]],
      ['team/manual', [makeSkill('manual-skill')]],
    ])
    const installed = Array.from({ length: 35 }, (_, i) => ({ id: `installed-${i}`, name: `installed-${i}`, description: 'Un skill déjà installé.', scope: 'global', projectId: null, enabled: true, compat: [], problem: null, origin: null }))
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/__skills_navigation', (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="check" style="max-width:960px;margin:auto;padding:16px"></main></body></html>' }))
    await page.route('**/api/**', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const method = req.method()
      const send = (json, status = 200) => route.fulfill({ status, json })
      requests.push(`${method} ${url.pathname}`)
      if (url.pathname === '/api/auth/me') return send({ id: 'admin', isAdmin: admin })
      if (url.pathname === '/api/system/instance') return send({ profile, capabilities: { passwordAuth: profile === 'server', sharedProjects: profile === 'server' } })
      if (url.pathname === '/api/projects') return send([{ id: 'project-a', name: 'Projet test', isOwner: true, archivedAt: null }])
      if (url.pathname === '/api/skill-library') return send({ enabled: true, skills: installed })
      if (url.pathname === '/api/skill-library/local') return send({ skills: [{ ...makeSkill('native-skill'), origin: 'claude-repo' }] })
      if (url.pathname === '/api/skill-sources/search') {
        assert.ok(admin)
        const name = url.searchParams.get('q')
        return send({ available: directoryAvailable, results: directoryAvailable ? [{ name, repository: `team/${name}`, installs: 42, sourceId: sources.find((source) => source.name === `team/${name}`)?.id ?? null }] : [] })
      }
      if (url.pathname === '/api/skill-sources/discovery-description') return send({ description: 'Generate videos with multiple AI models. ' + 'Full description with capabilities and prerequisites. '.repeat(12) })
      if (url.pathname === '/api/skill-sources') {
        if (method === 'GET') return send({ sources })
        assert.ok(admin)
        const body = req.postDataJSON()
        assert.ok(!sources.some((source) => source.name === body.url), 'source registered twice')
        const source = makeSource(`source-${sources.length}`, body.url, false)
        sources.push(source)
        return send(source, 201)
      }
      const source = sources.find((item) => url.pathname.startsWith(`/api/skill-sources/${item.id}/`))
      if (source && url.pathname.endsWith('/refresh')) {
        assert.ok(admin)
        await delay(120)
        if (failRefresh.delete(source.name)) return send({ error: { code: 'test_fetch_failed', message: 'Récupération impossible pour ce test' } }, 502)
        source.lastCommit = 'abcdef123456'
        return send(source)
      }
      if (source && url.pathname.endsWith('/catalog')) return send({ source, skills: catalogs.get(source.name) ?? [] })
      if (source && url.pathname.endsWith('/preview')) return send({ main: '# Instructions du skill', files: ['SKILL.md'] })
      if (source && url.pathname.endsWith('/install')) {
        const body = req.postDataJSON()
        const skill = catalogs.get(source.name).find((item) => item.path === body.path)
        assert.ok(skill, 'must install the requested skill path')
        const result = { ...skill, id: `new-${installed.length}`, name: body.name ?? skill.name, scope: body.scope, projectId: body.projectId, enabled: true, compat: [], origin: null }
        skill.installed.push({ skillId: result.id, name: result.name, scope: body.scope, projectId: body.projectId })
        installed.push(result)
        return send(result, 201)
      }
      unexpected.push(`${method} ${url.pathname}`)
      return send({}, 500)
    })
    await mount(page)
    await page.getByText('installed-34', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Ajouter une source', exact: true }).count(), 0)
    assert.equal(await page.getByRole('textbox', { name: 'Rechercher un skill', exact: true }).count(), 0)
    await page.getByRole('tab', { name: 'Installés', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await page.getByRole('tab', { name: 'Découvrir', exact: true, selected: true }).waitFor()
    assert.equal(await page.getByText('installed-34', { exact: true }).count(), 0)
    const query = page.getByRole('textbox', { name: 'Rechercher un skill', exact: true })
    await query.fill('wanted')
    await page.getByText('wanted', { exact: true }).waitFor()
    await page.getByText('42 installations sur skills.sh', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Lire toute la description', exact: true }).click()
    await page.getByRole('button', { name: 'Réduire', exact: true }).waitFor()
    assert.equal(await page.getByRole('link', { name: 'Fiche complète sur skills.sh' }).getAttribute('href'), 'https://skills.sh/team/wanted/wanted')
    assert.equal(await page.getByRole('link', { name: 'Dépôt GitHub' }).getAttribute('href'), 'https://github.com/team/wanted')
    await page.getByRole('button', { name: 'Réduire', exact: true }).click()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: `/var/tmp/sillage-skills-discover-${profile}-${viewport.width}.png` })
    await page.getByRole('button', { name: 'Installer…', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Installer wanted', exact: true })
    await dialog.getByRole('button', { name: 'Installer le skill', exact: true }).click()
    await dialog.getByText('Récupération impossible pour ce test').waitFor()
    assert.equal(await page.getByRole('dialog', { name: 'Catalogues de skills' }).count(), 0)
    assert.equal(installed.length, 35)
    await dialog.getByRole('button', { name: 'Installer le skill', exact: true }).click()
    await dialog.getByRole('button', { name: 'Terminer', exact: true }).waitFor()
    assert.equal(installed.length, 36)
    assert.equal(installed.at(-1).path, 'nested/not-the-name')
    assert.equal(requests.filter((r) => r === 'POST /api/skill-sources').length, 1)
    await page.screenshot({ path: `/var/tmp/sillage-skills-installed-${profile}-${viewport.width}.png` })
    await dialog.getByRole('button', { name: 'Terminer', exact: true }).click()
    // Retrying an already completed installation is idempotent, including after a lost response.
    await page.getByRole('button', { name: 'Installer…', exact: true }).click()
    await dialog.getByRole('button', { name: 'Installer le skill', exact: true }).click()
    await dialog.getByRole('button', { name: 'Terminer', exact: true }).click()
    assert.equal(installed.length, 36)
    for (const name of ['missing', 'ambiguous', 'disabled']) {
      await query.fill(name)
      await page.getByText(name, { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Installer…', exact: true }).click()
      dialog = page.getByRole('dialog', { name: `Installer ${name}`, exact: true })
      await dialog.getByRole('button', { name: 'Installer le skill', exact: true }).click()
      await dialog.getByRole('alert').waitFor()
      assert.equal(await page.getByRole('dialog', { name: 'Catalogues de skills' }).count(), 0)
      assert.equal(installed.length, 36)
      await dialog.getByRole('button', { name: 'Annuler', exact: true }).click()
    }
    directoryAvailable = false
    await query.fill('offline')
    await page.getByText(/L’annuaire skills.sh est indisponible/).waitFor()
    assert.ok(await query.isVisible())
    await page.getByRole('combobox', { name: 'Rechercher dans', exact: true }).click()
    await page.getByRole('option', { name: 'Mes sources', exact: true }).click()
    await query.fill('local')
    await page.getByText('local-one', { exact: true }).waitFor()
    await page.getByText('local-two', { exact: true }).waitFor()
    const searchCount = requests.filter((r) => r.includes('/search')).length
    await query.fill('local-one')
    await delay(400)
    assert.equal(requests.filter((r) => r.includes('/search')).length, searchCount)
    await page.getByRole('button', { name: 'Installer…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Installer local-one', exact: true })
    await dialog.getByRole('combobox', { name: 'Destination', exact: true }).click()
    await page.getByRole('option', { name: /Projet test/ }).click()
    await dialog.getByText('Lire les instructions du skill', { exact: true }).click()
    await dialog.getByText('# Instructions du skill', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Installer le skill', exact: true }).click()
    await dialog.getByRole('button', { name: 'Terminer', exact: true }).click()
    assert.equal(installed.at(-1).projectId, 'project-a')
    await page.getByRole('tab', { name: 'Sources', exact: true }).click()
    await page.getByRole('button', { name: 'Ajouter une source', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Ajouter une source', exact: true })
    await dialog.getByRole('textbox', { name: 'Dépôt', exact: true }).fill('team/manual')
    await page.screenshot({ path: `/var/tmp/sillage-skills-source-${profile}-${viewport.width}.png` })
    await dialog.getByRole('button', { name: 'Ajouter et récupérer', exact: true }).click()
    await dialog.getByText('Récupération impossible pour ce test').waitFor()
    const createCount = requests.filter((r) => r === 'POST /api/skill-sources').length
    await dialog.getByRole('button', { name: 'Réessayer la récupération', exact: true }).click()
    const catalog = page.getByRole('dialog', { name: 'Catalogues de skills' })
    await catalog.getByRole('checkbox', { name: 'Sélectionner manual-skill', exact: true }).waitFor()
    assert.equal(requests.filter((r) => r === 'POST /api/skill-sources').length, createCount)
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: 'Mises à jour', exact: true }).click()
    await page.getByText(/Aucun skill installé depuis une source/).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Ajouter une source', exact: true }).count(), 0)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    // A requested but unavailable source must never fall back to the first available catalog.
    await mount(page, 'missing')
    await page.getByRole('alert').filter({ hasText: /Cette source est introuvable/ }).waitFor()
    assert.equal(await page.getByRole('checkbox').count(), 0)
    // Owners without admin rights can discover/install saved skills in their project only.
    admin = false
    await mount(page, 'project')
    assert.equal(await page.getByText('native-skill', { exact: true }).count(), 0)
    await page.getByRole('tab', { name: 'Dépôt', exact: true }).click()
    await page.getByText('native-skill', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Découvrir', exact: true }).click()
    await page.getByRole('textbox', { name: 'Rechercher un skill', exact: true }).fill('local-two')
    await page.getByRole('button', { name: 'Installer…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Installer local-two', exact: true })
    await dialog.getByRole('button', { name: 'Installer le skill', exact: true }).click()
    await dialog.getByRole('button', { name: 'Terminer', exact: true }).click()
    assert.equal(installed.at(-1).scope, 'project')
    assert.equal(installed.at(-1).projectId, 'project-a')
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
    await context.close()
    console.log(`OK skills navigation ${profile} ${viewport.width}: tabs, search scope, direct install, retries, missing/ambiguous/disabled sources, permissions.`)
  }
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
  await once(vite, 'exit')
}
