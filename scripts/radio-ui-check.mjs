import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Claude FM end to end on the desktop profile (no password, so no account to create): the rail
// switch opens the player, the player survives navigation, the palette stops it, and the phone
// layout keeps it clear of the composer. The server follows the real https://clau.de/radio link.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(process.env.SILLAGE_CHECK_TMP ?? tmpdir(), 'sillage-radio-check-'))
const shots = process.env.SILLAGE_CHECK_SHOTS ?? data
const processes = []
let browser

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env, stdio = 'pipe') {
  const child = spawn(process.execPath, args, { cwd, env, stdio })
  processes.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  }
  return child
}

try {
  const env = { ...process.env }
  delete env.NODE_ENV
  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...env, NODE_ENV: 'production' })
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, {
    ...env,
    SILLAGE_PROFILE: 'desktop',
    SILLAGE_HANDSHAKE_FD: '3',
    SILLAGE_PORT: String(await freePort()),
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: webDist,
  }, ['pipe', 'pipe', 'pipe', 'pipe'])
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    server.stdio[3].setEncoding('utf8')
    server.stdio[3].on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end !== -1) resolve(JSON.parse(buffer.slice(0, end)))
    })
    server.once('exit', () => reject(new Error(`server stopped: ${server.diagnostics}`)))
  })
  const origin = `http://127.0.0.1:${handshake.port}`

  browser = await chromium.launch()
  const errors = []
  const open = async (viewport) => {
    const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    await context.addCookies([{ name: 'sillage_session', value: handshake.session, url: origin }])
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    return page
  }

  const request = (await open({ width: 800, height: 600 })).context().request
  // Past the first-run tour: the check is about the shell it leads to.
  const settled = await request.patch(`${origin}/api/me/settings`, { headers: { origin }, data: { onboarding: { pending: false, interfaceTourPending: false } } })
  assert.ok(settled.ok(), await settled.text())
  const station = await (await request.get(`${origin}/api/radio`)).json()
  assert.match(station.videoId, /^[\w-]{6,20}$/)
  assert.equal(station.link, 'https://clau.de/radio')

  // The real embed needs H.264, which headless Chromium lacks: a stub player at YouTube's origin
  // speaks the embed protocol instead, starting playback when told to listen, or never.
  const stubPlayer = async (page, starts) => page.route(`https://www.youtube-nocookie.com/embed/${station.videoId}?*`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<body style="background:#000"><script>addEventListener('message', (event) => {
      if (JSON.parse(event.data).event === 'listening' && ${starts}) parent.postMessage(JSON.stringify({ event: 'onStateChange', info: 1 }), '*')
    })</script></body>`,
  }))

  // Wide screen: a switch in the rail, sound only, kept across pages.
  const page = await open({ width: 1440, height: 900 })
  await stubPlayer(page, true)
  await page.goto(`${origin}/discussions`)
  const toggle = page.locator('[data-radio-toggle]')
  await toggle.waitFor()
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
  await toggle.click()
  const player = page.locator('[data-radio-player]')
  const frame = player.locator('iframe')
  await frame.waitFor({ state: 'attached' })
  assert.ok((await frame.getAttribute('src')).includes(`/embed/${station.videoId}?autoplay=1`))
  await page.locator('[data-radio-toggle=playing]').waitFor()
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
  assert.equal(await player.getAttribute('data-radio-player'), 'hidden')
  assert.equal(await player.evaluate((node) => getComputedStyle(node).opacity), '0')
  await page.screenshot({ path: join(shots, 'radio-wide.png') })

  // Navigation keeps the same iframe, hence the sound.
  await frame.evaluate((node) => { node.dataset.marker = 'kept' })
  await page.locator('[data-nav-space=services]').click()
  await page.waitForURL(/\/services$/)
  assert.equal(await frame.getAttribute('data-marker'), 'kept')

  // The palette offers the opposite of the current state.
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Rechercher', exact: true })
  await palette.getByRole('combobox').fill('radio')
  await palette.getByRole('option', { name: /Arrêter la radio/ }).click()
  await player.waitFor({ state: 'detached' })
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false')

  // A station of one's own, from personal settings: the rail takes its name from YouTube.
  const lofi = 'jfKfPfyJRdk'
  await page.goto(`${origin}/settings/radio`)
  const field = page.locator('[data-radio-url]')
  await field.fill('https://example.com/stream.mp3')
  await page.getByText('Ce n’est pas un lien de vidéo ou de live YouTube.').waitFor()
  await field.fill(`https://youtu.be/${lofi}?si=x`)
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.getByText('Enregistré.').waitFor()
  await page.screenshot({ path: join(shots, 'radio-settings.png') })
  const custom = await (await page.context().request.get(`${origin}/api/radio`)).json()
  assert.equal(custom.videoId, lofi)
  assert.equal(custom.custom, true)
  // A titled one, through a /live/ link: the rail takes its YouTube title.
  await field.fill(`https://www.youtube.com/live/${station.videoId}?si=x`)
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.locator('[data-radio-toggle][aria-label^="Claude FM 🎵"]').waitFor()
  await field.fill(`https://youtu.be/${lofi}?si=x`)
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.getByText('Enregistré.').waitFor()
  // Some videos give oEmbed no title: the rail then says Radio.
  await page.locator(`[data-radio-toggle][aria-label="${custom.title ?? 'Radio'} — Cliquer pour écouter"]`).waitFor()
  await page.getByRole('button', { name: 'Revenir à Claude FM' }).click()
  await page.locator('[data-radio-url]').and(page.locator('[value=""]')).waitFor()
  assert.equal((await (await page.context().request.get(`${origin}/api/radio`)).json()).custom, false)

  // Phone whose browser refuses to start sound: the player shows itself to be tapped, on screen.
  const phone = await open({ width: 390, height: 844 })
  await stubPlayer(phone, false)
  await phone.goto(`${origin}/discussions`)
  await phone.locator('[data-navigation-trigger]').first().click()
  await phone.locator('[data-radio-toggle]').click()
  await phone.locator('[data-radio-toggle=tuning]').waitFor()
  await phone.locator('[data-radio-player=shown]').waitFor({ timeout: 15000 })
  await phone.locator('[data-radio-toggle=blocked]').waitFor()
  const phoneBox = await phone.locator('[data-radio-player]').boundingBox()
  assert.ok(phoneBox.y < 200 && phoneBox.x + phoneBox.width <= 390, 'phone player at the top, on screen')
  await phone.screenshot({ path: join(shots, 'radio-phone-blocked.png') })

  assert.deepEqual(errors, [])
  console.log(`radio check passed (live ${station.videoId}); screenshots in ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  if (!process.env.SILLAGE_CHECK_SHOTS) await rm(data, { recursive: true, force: true })
}
