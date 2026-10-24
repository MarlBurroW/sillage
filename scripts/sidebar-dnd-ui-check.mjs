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

// Reordering sessions in the sidebar must keep working drop after drop, with archived and
// scheduled rows interleaved in the stored order, with rows hidden behind "show more", and by
// touch. The optimistic update once duplicated ids until the refetch, which broke later drags.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-sidebar-dnd-check-'))
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

function arrayMove(list, from, to) {
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = {
    ...process.env,
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

  const session = async (viewport, mobile) => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    const apiOrder = async () => (await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json())
      .filter((entry) => !entry.archivedAt && !entry.scheduleId).map((entry) => entry.id)
    const rows = page.locator('[data-sidebar-session][aria-roledescription="sortable"]')
    const domOrder = () => rows.evaluateAll((elements) => elements.map((element) => element.dataset.sidebarSession))
    const drag = async (from, to) => {
      const a = await rows.nth(from).boundingBox()
      const b = await rows.nth(to).boundingBox()
      const x = a.x + a.width / 2
      const y0 = a.y + a.height / 2
      const y1 = b.y + b.height / 2 + (to > from ? 4 : -4)
      if (mobile) {
        // Long press, then move: the touch sensor activates after 250 ms without movement.
        const cdp = await context.newCDPSession(page)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] })
        await delay(400)
        for (let step = 1; step <= 20; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (y1 - y0) * step / 20 }] })
        await delay(100)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await cdp.detach()
      } else {
        await page.mouse.move(x, y0)
        await page.mouse.down()
        await page.mouse.move(x, y0 + 10, { steps: 3 })
        await page.mouse.move(x, y1, { steps: 15 })
        await delay(100)
        await page.mouse.up()
      }
      await page.waitForTimeout(900)
    }
    const expectMove = async (from, to) => {
      const before = await domOrder()
      await drag(from, to)
      const expected = arrayMove(before, from, to)
      assert.deepEqual(await domOrder(), expected, `rows after dragging ${from} to ${to}`)
      const stored = await apiOrder()
      assert.deepEqual(stored.filter((id) => expected.includes(id)), expected, `stored order after dragging ${from} to ${to}`)
      assert.deepEqual(errors, [])
      assert.equal(page.url(), `${base}/p/${project.id}/c/new`, 'dropping must not open the session')
    }
    await page.goto(`${base}/p/${project.id}/c/new`)
    await page.locator('textarea').waitFor()
    return { context, page, project, errors, rows, domOrder, apiOrder, drag, expectMove }
  }

  // Desktop: the seeded project stores scheduled runs before the active sessions, the case that
  // duplicated ids. Every drop must land, including after the preceding ones.
  {
    const { context, page, expectMove, rows } = await session({ width: 1440, height: 900 }, false)
    await page.waitForTimeout(500)
    assert.ok(await rows.count() >= 7)
    for (const [from, to] of [[0, 3], [3, 0], [5, 0], [6, 0], [1, 6], [4, 0], [2, 2]]) await expectMove(from, to)
    console.log('Desktop reordering verified across consecutive drops')
    await context.close()
  }

  // Focused view with more than ten sessions: only the first ten plus favorites are shown, and a
  // drop next to a favorite shown beyond them must land next to it in the stored order.
  {
    const { context, page, project, apiOrder, domOrder, drag, expectMove, rows } = await session({ width: 1440, height: 900 }, false)
    const config = { agent: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'auto', additionalDirectories: [], mcpServers: [], sillageMcp: true, skillLibrary: true }
    for (let index = 0; index < 12; index++) {
      const created = await context.request.post(`${base}/api/projects/${project.id}/conversations`, { data: { agent: 'claude', title: `Extra ${index}`, config } })
      assert.ok(created.ok(), await created.text())
    }
    const stored = await apiOrder()
    const far = stored[stored.length - 1]
    assert.ok((await context.request.put(`${base}/api/conversations/${far}/favorite`)).ok())
    await page.reload()
    await page.locator('textarea').waitFor()
    await page.waitForTimeout(500)
    assert.equal(await rows.count(), 11)
    await expectMove(0, 5)
    await expectMove(5, 0)
    const visible = await domOrder()
    assert.equal(visible[visible.length - 1], far)
    const dragged = visible[0]
    await drag(0, visible.length - 1)
    const after = await apiOrder()
    assert.equal(after.indexOf(dragged), after.indexOf(far) + 1, 'the row lands right after the favorite it was dropped on')
    console.log('Collapsed list reordering verified, including a drop beyond the first ten rows')
    await context.close()
  }

  // Phone: long press drags, and the drop must not open the session either.
  {
    const { context, page, expectMove, rows } = await session({ width: 390, height: 844 }, true)
    await page.getByRole('button', { name: /navigation/i }).first().click()
    await page.waitForTimeout(500)
    assert.ok(await rows.count() >= 6)
    for (const [from, to] of [[0, 3], [3, 0], [5, 1]]) await expectMove(from, to)
    console.log('Touch reordering verified')
    await context.close()
  }
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await delay(200)
  await rm(data, { recursive: true, force: true })
}
