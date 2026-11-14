import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// The panel toggle on an isolated demo: no production reads/writes.
// SHOTS=<dir> also keeps a capture of every state; CAPTURE_ONLY=1 skips the assertions.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-toggle-check-'))
const shots = process.env.SHOTS
const captureOnly = process.env.CAPTURE_ONLY === '1'
const processes = []
let browser

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'pipe' })
  processes.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  }
  return child
}

async function ready(url, child) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

const OPEN = 'Ouvrir le panneau'
const CLOSE = 'Fermer le panneau'

/** The visible toggle, whichever header currently holds it. */
async function toggleBox(page, name) {
  const boxes = await page.getByRole('button', { name, exact: true }).evaluateAll((nodes) => nodes
    .filter((node) => node.checkVisibility({ visibilityProperty: true }))
    .map((node) => {
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }))
  assert.equal(boxes.length, 1, `exactly one visible “${name}” button, found ${boxes.length}`)
  return boxes[0]
}

/** Nothing interactive in the top bar may sit to the right of the toggle. */
async function assertRightmost(page, box, label) {
  const beyond = await page.evaluate(({ right, bottom }) => [...document.querySelectorAll('button, a[href]')]
    .filter((node) => node.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !node.closest('[inert], [aria-hidden="true"]'))
    .map((node) => ({ rect: node.getBoundingClientRect(), name: node.getAttribute('aria-label') ?? node.textContent }))
    .filter(({ rect }) => rect.width > 0 && rect.top < bottom && rect.left >= right - 1)
    .map(({ name }) => name), { right: box.x + box.width, bottom: box.y + box.height })
  assert.deepEqual(beyond, [], `${label}: controls right of the toggle`)
}

try {
  if (shots) await mkdir(shots, { recursive: true })
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = {
    ...process.env,
    // Demo repository has no identity: git uses environment's identity.
    GIT_AUTHOR_NAME: 'Alex Demo',
    GIT_AUTHOR_EMAIL: 'alex@example.test',
    GIT_COMMITTER_NAME: 'Alex Demo',
    GIT_COMMITTER_EMAIL: 'alex@example.test',
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })

  // `expanded` is the overlay layout a wide window can choose instead of the docked column.
  const layouts = [
    { name: 'docked', width: 1440, expanded: false },
    { name: 'overlay', width: 1440, expanded: true },
    { name: 'tablet', width: 900, expanded: false },
    { name: 'phone', width: 390, expanded: false },
  ]

  for (const layout of layouts) {
    const mobile = layout.width < 700
    const context = await browser.newContext({
      viewport: { width: layout.width, height: 900 }, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', serviceWorkers: 'block',
    })
    await context.addInitScript((expanded) => {
      localStorage.setItem('sillage.locale', 'fr')
      localStorage.setItem('sillage.panelExpanded', expanded ? '1' : '0')
      localStorage.setItem('sillage.panelOpen', '0')
    }, layout.expanded)
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
    const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))

    const views = [
      { name: 'conversation', path: `/p/${project.id}/c/${hero.id}` },
      { name: 'draft', path: `/p/${project.id}/c/new` },
      { name: 'board', path: `/p/${project.id}/board` },
    ]
    for (const view of views) {
      const label = `${view.name} ${layout.name}`
      await page.goto(`${base}${view.path}`)
      await page.evaluate(() => localStorage.setItem('sillage.panelOpen', '0'))
      await page.reload()
      await page.getByRole('button', { name: OPEN, exact: true }).first().waitFor()
      await page.waitForTimeout(400)
      if (shots) await page.screenshot({ path: join(shots, `${view.name}-${layout.name}-closed.png`) })

      const closed = captureOnly ? null : await toggleBox(page, OPEN)
      if (closed) {
        await assertRightmost(page, closed, `${label} closed`)
        assert.ok(layout.width - (closed.x + closed.width) <= 16, `${label}: closed toggle ${layout.width - (closed.x + closed.width)}px from the edge`)
      }

      // Same spot both ways: opening must leave the pointer on the control that closes.
      const spot = closed
        ? { x: closed.x + closed.width / 2, y: closed.y + closed.height / 2 }
        : null
      if (spot) await (mobile ? page.touchscreen.tap(spot.x, spot.y) : page.mouse.click(spot.x, spot.y))
      else await page.getByRole('button', { name: OPEN, exact: true }).first().click()
      const panel = page.locator('[data-panel="workspace"]')
      await panel.waitFor()
      await page.waitForTimeout(450)
      if (shots) await page.screenshot({ path: join(shots, `${view.name}-${layout.name}-open.png`) })

      if (spot) {
        const opened = await toggleBox(page, CLOSE)
        await assertRightmost(page, opened, `${label} open`)
        assert.ok(layout.width - (opened.x + opened.width) <= 16, `${label}: open toggle ${layout.width - (opened.x + opened.width)}px from the edge`)
        assert.ok(
          spot.x > opened.x && spot.x < opened.x + opened.width && spot.y > opened.y && spot.y < opened.y + opened.height,
          `${label}: the toggle moved away from the pointer (${JSON.stringify(closed)} → ${JSON.stringify(opened)})`,
        )
        // The page's copy stands down while the panel shows its own: no focus left inside a hidden
        // control, and no tooltip stranded where it used to be.
        const focus = await page.evaluate(() => {
          const active = document.activeElement
          return { hidden: Boolean(active?.closest('[aria-hidden="true"]')), inPanel: Boolean(active?.closest('[data-panel="workspace"]')) }
        })
        assert.deepEqual(focus, { hidden: false, inPanel: true }, `${label}: focus after opening`)
        for (const tip of await page.getByRole('tooltip').evaluateAll((nodes) => nodes.map((node) => node.parentElement.getBoundingClientRect().right))) {
          assert.ok(tip > opened.x, `${label}: a tooltip is left at x=${tip}, away from the toggle`)
        }
        if (view.name === 'conversation') {
          // The explorer below has its own search: the header only offers quick open while the
          // explorer is hidden, and the toggle that hides it stays put.
          const quickOpen = panel.getByRole('button', { name: 'Ouvrir un fichier', exact: true })
          const hide = panel.getByRole('button', { name: "Masquer l'arborescence", exact: true })
          const show = panel.getByRole('button', { name: "Afficher l'arborescence", exact: true })
          assert.equal(await quickOpen.count(), 0, `${label}: quick open beside the explorer's search`)
          const tree = await hide.boundingBox()
          await hide.click()
          assert.deepEqual(await show.boundingBox(), tree, `${label}: the tree toggle moved`)
          const quick = await quickOpen.boundingBox()
          assert.ok(quick.x + quick.width <= tree.x, `${label}: quick open is not left of the tree toggle`)
          if (shots) await page.screenshot({ path: join(shots, `${view.name}-${layout.name}-tree-hidden.png`) })
          await show.click()
          await hide.waitFor()
        }
        await (mobile ? page.touchscreen.tap(spot.x, spot.y) : page.mouse.click(spot.x, spot.y))
        await panel.waitFor({ state: 'detached' })
        const again = await toggleBox(page, OPEN)
        assert.deepEqual(again, closed, `${label}: the toggle did not return to its place`)
      }
      console.log(`${captureOnly ? 'Captured' : 'Verified'}: ${label}`)
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
} finally {
  await browser?.close()
  for (const child of processes.reverse()) child.kill('SIGTERM')
  await delay(400)
  await rm(data, { recursive: true, force: true })
}
