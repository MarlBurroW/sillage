import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Relations des tickets : Server et Desktop, grand écran et téléphone.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-ui-check-'))
const processes = []
let browser

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env, stdio = 'pipe', executable = process.execPath) {
  const child = spawn(executable, args, { cwd, env, stdio })
  processes.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  }
  return child
}

async function ready(url, child) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

try {
  // Desktop sert le build sur son propre port : son contrôle d’origine refuse Vite.
  const build = run(['--filter', '@sillage/web', 'build'], root, { ...process.env, NODE_ENV: 'production' }, 'pipe', 'pnpm')
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const profile of ['server', 'desktop']) {
    const apiPort = await freePort()
    const webPort = await freePort()
    const config = join(data, `${profile}.toml`)
    await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n')
    const env = { ...process.env, NODE_ENV: 'development', SILLAGE_CONFIG: config,
      SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1',
      SILLAGE_DATA_DIR: join(data, profile), SILLAGE_WEB_ROOT: profile === 'desktop' ? join(webDir, 'dist') : join(data, 'web') }
    delete env.SILLAGE_PROFILE
    delete env.SILLAGE_HANDSHAKE_FD
    const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
    const [seedCode] = await once(seed, 'exit')
    assert.equal(seedCode, 0, seed.diagnostics)
    const serverEnv = profile === 'desktop' ? { ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3' } : env
    const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, serverEnv, ['pipe', 'pipe', 'pipe', 'pipe'])
    const handshake = profile === 'desktop' ? new Promise(resolve => {
      let output = ''
      server.stdio[3].on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output)) })
    }) : null
    const base = `http://127.0.0.1:${profile === 'desktop' ? apiPort : webPort}`
    await ready(`http://127.0.0.1:${apiPort}/api/health`, server)
    if (profile === 'server') {
      const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
      await ready(base, vite)
    }
    for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block' })
      await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
      if (handshake) {
        const { session } = await handshake
        await context.addCookies([{ name: 'sillage_session', value: session, url: base, httpOnly: true, sameSite: 'Lax' }])
      } else assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
      const projects = await (await context.request.get(`${base}/api/projects`)).json()
      const project = projects.find(p => p.name === 'Nimbus')
      const cards = await (await context.request.get(`${base}/api/projects/${project.id}/cards`)).json()
      const card = number => cards.find(c => c.number === number)
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const board = `${base}/p/${project.id}/board`
      await page.goto(`${board}?carte=1`)
      const section = page.getByRole('region', { name: 'Relations', exact: true })
      await section.waitFor()
      // Chaque type se crée depuis le ticket, sans manipulation de sa description.
      for (const [target, label] of [[2, 'Bloque'], [3, 'Est lié à'], [4, 'Est un doublon de'], [5, 'Contient le sous-ticket'], [6, 'Remplace']]) {
        await section.getByRole('button', { name: 'Ajouter une relation', exact: true }).click()
        await section.getByRole('combobox', { name: 'Ce ticket…' }).click()
        await page.getByRole('option', { name: label, exact: true }).click()
        await section.getByLabel('Chercher un ticket', { exact: true }).fill(`#${target}`)
        await section.getByRole('list', { name: 'Tickets correspondants' }).getByRole('button', { name: new RegExp(`^#${target} `) }).click()
        await section.getByRole('button', { name: 'Ajouter le lien', exact: true }).click()
        await section.getByRole('button', { name: 'Ajouter une relation', exact: true }).waitFor()
        await section.getByText(label, { exact: true }).waitFor()
      }
      await section.scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: `/var/tmp/sillage-relations-${profile}-${size}.png` })
      await section.getByRole('button', { name: new RegExp(`#2 ${card(2).title}`) }).click()
      await page.waitForURL(/carte=2$/)
      await section.getByText('Est bloqué par', { exact: true }).waitFor()
      // Suppression depuis le sens inverse, puis contrôle sur la carte de départ.
      await section.getByRole('button', { name: 'Retirer le lien avec #1', exact: true }).click()
      await section.getByText('Aucune relation pour le moment.', { exact: true }).waitFor()
      await page.goto(`${board}?carte=1`)
      await section.getByText('Est lié à', { exact: true }).waitFor()
      assert.equal(await section.getByText('Bloque', { exact: true }).count(), 0)
      for (const target of [3, 4, 5, 6]) {
        await section.getByRole('button', { name: `Retirer le lien avec #${target}`, exact: true }).click()
        await section.getByRole('button', { name: `Retirer le lien avec #${target}`, exact: true }).waitFor({ state: 'detached' })
      }
      await section.getByText('Aucune relation pour le moment.', { exact: true }).waitFor()
      // La recherche par titre fonctionne aussi, et annuler n’écrit rien.
      await section.getByRole('button', { name: 'Ajouter une relation', exact: true }).click()
      await section.getByLabel('Chercher un ticket', { exact: true }).fill('offline')
      await section.getByRole('list', { name: 'Tickets correspondants' }).getByRole('button', { name: /Offline caching/ }).waitFor()
      await section.getByRole('button', { name: 'Annuler', exact: true }).click()
      assert.deepEqual(await (await context.request.get(`${base}/api/cards/${card(1).id}/relations`)).json(), [])
      assert.deepEqual(errors, [])
      await context.close()
      console.log(`OK : ${profile}, ${size}, cinq relations, sens inverse, suppression, recherche.`)
    }
  }
} finally {
  await browser?.close()
  await Promise.all(processes.map(async child => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}
