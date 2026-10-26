import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { defaultConfigFor, DEFAULT_ONBOARDING } from '../packages/protocol/src/index.ts'

// Exercise the real routes and components on isolated Server and Desktop databases.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverBase = process.env.SILLAGE_CHECK_URL ?? 'http://127.0.0.1:7489'
const artifacts = '/var/tmp/sillage-discussions-check'
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ chromiumSandbox: true })
let desktop
const errors = []
const shot = async (page, name) => page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true })
const json = async response => { assert.ok(response.ok(), `${response.status()}: ${await response.text()}`); return response.status() === 204 ? null : response.json() }

async function exercise(profile, base, handshake) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: profile === 'desktop' ? 'dark' : 'light', locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  if (handshake) await context.addCookies([{ name: 'sillage_session', value: handshake.session, url: base }])
  else {
    const info = await json(await context.request.get(`${base}/api/system/instance`))
    await json(await context.request.post(`${base}/api/auth/${info.needsSetup ? 'setup' : 'login'}`, { data: { username: 'demo', displayName: 'Démo', password: 'sillage-demo' } }))
  }
  const projectsDir = await mkdtemp('/var/tmp/sillage-discussion-projects-')
  await json(await context.request.patch(`${base}/api/me/settings`, { data: { onboarding: DEFAULT_ONBOARDING, projectsDir } }))
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(`${profile}: ${error.message}`))
  const failures = []
  page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 500) failures.push(`${response.status()} ${response.url()}`) })
  await page.goto(`${base}/discussions/new`)
  await page.getByRole('heading', { name: 'Nouvelle discussion', exact: true }).waitFor()
  assert.equal(await page.getByText('Discussion personnelle · sans projet').count(), 1)
  await shot(page, `${profile}-new`)
  const session = await json(await context.request.post(`${base}/api/discussions`, { data: { agent: 'codex', config: defaultConfigFor('codex'), title: `Une idée à explorer (${profile} ${Date.now()})` } }))
  const workspaces = await json(await context.request.get(`${base}/api/discussions/workspaces`))
  const workspace = workspaces.find(entry => entry.conversations.some(row => row.id === session.id))
  await writeFile(join(workspace.path, 'idea.md'), '# Idée\nUn carnet de lecture personnel.\n')
  await page.goto(`${base}/discussions/${session.id}`)
  await page.getByRole('button', { name: 'Options des discussions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Mémoire personnelle' }).click()
  await page.getByRole('button', { name: 'Ajouter un souvenir' }).click()
  const note = `preference-${Date.now()}`
  await page.getByLabel('Nom du fichier de la note').fill(note)
  await page.getByLabel('Ce qu’il faut retenir').fill('Je préfère les explications en français.')
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await page.getByRole('button', { name: `${note}.md`, exact: true }).waitFor()
  await page.getByText('Modifications récentes', { exact: true }).click()
  await page.getByText(new RegExp(`${note}.md ·`)).waitFor()
  await shot(page, `${profile}-memory`)

  await page.goto(`${base}/discussions/${session.id}`)
  await page.locator('header').getByRole('button', { name: 'Actions de la conversation', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Créer un projet', exact: true }).click()
  await page.getByLabel('Nom', { exact: true }).fill(`Carnet ${profile}`)
  await page.getByLabel('Résumé pour la nouvelle session').fill('Créer un carnet de lecture simple, avec une liste de livres et des notes personnelles.')
  await page.getByRole('checkbox', { name: 'idea.md' }).check()
  if (profile === 'desktop') assert.equal(await page.getByText('Visibilité', { exact: true }).count(), 0)
  await shot(page, `${profile}-create-project`)
  await page.getByRole('button', { name: 'Créer le projet', exact: true }).click()
  await page.waitForURL(/\/p\/[^/]+\/c\/[^/]+$/)
  const targetId = page.url().split('/').at(-1)
  const target = await json(await context.request.get(`${base}/api/conversations/${targetId}`))
  assert.equal(target.handoffFromId, session.id)
  const transfer = await json(await context.request.get(`${base}/api/conversations/${targetId}/handoff`))
  assert.match(transfer.text, /carnet de lecture simple/)
  assert.doesNotMatch(transfer.text, /Je préfère les explications/)
  await page.goto(`${base}/discussions/${session.id}`)
  await page.getByText('Sessions de projet créées depuis cette discussion').waitFor()
  await shot(page, `${profile}-thread`)

  // Phone: navigation, context dialog, project transfer and files stay usable at 390 px.
  await page.setViewportSize({ width: 390, height: 844 })
  await shot(page, `${profile}-phone-thread`)
  await page.locator('header').getByRole('button', { name: 'Actions de la conversation', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Créer un projet', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.ok(await page.getByRole('dialog').evaluate(node => node.getBoundingClientRect().width <= innerWidth))
  await shot(page, `${profile}-phone-create-project`)
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  await page.goto(`${base}/discussions/memory`)
  await page.getByRole('button', { name: 'Ajouter un souvenir' }).waitFor()
  await shot(page, `${profile}-phone-memory`)
  await json(await context.request.delete(`${base}/api/conversations/${session.id}`))
  await page.goto(`${base}/discussions/files`)
  await page.getByRole('button', { name: session.title, exact: true }).click()
  await page.getByText('idea.md', { exact: true }).first().waitFor()
  assert.ok(await page.getByText('idea.md', { exact: true }).first().evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }))
  await shot(page, `${profile}-phone-files`)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.getByText('idea.md', { exact: true }).first().click()
  await page.getByText(/Un carnet de lecture personnel/).waitFor()
  await shot(page, `${profile}-phone-editor`)
  await page.getByRole('button', { name: "Afficher l'arborescence", exact: true }).click()
  await page.getByText('idea.md', { exact: true }).first().waitFor()
  assert.deepEqual(failures, [])
  await context.close()
  console.log(`${profile}: discussion, personal memory, explicit project transfer, retained folder, desktop and phone passed`)
}

try {
  await exercise('server', serverBase)
  const data = await mkdtemp('/var/tmp/sillage-discussion-desktop-')
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n[agents.antigravity]\nenabled = false\n')
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const desktopPort = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  desktop = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(root, 'apps/server'),
    env: { ...process.env, NODE_ENV: 'development', SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3', SILLAGE_PORT: String(desktopPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: join(root, 'apps/web/dist') },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  desktop.stderr.on('data', chunk => { diagnostics += chunk.toString() })
  desktop.stdout.on('data', chunk => { diagnostics += chunk.toString() })
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(diagnostics)), 30000)
    desktop.stdio[3].on('data', chunk => { buffer += chunk.toString(); if (buffer.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buffer.split('\n')[0])) } })
    desktop.once('exit', () => { clearTimeout(timer); reject(new Error(diagnostics)) })
  })
  await exercise('desktop', `http://127.0.0.1:${handshake.port}`, handshake)
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  if (desktop) { desktop.stdin.end(); await delay(200); desktop.kill() }
}
