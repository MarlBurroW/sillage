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

// Sign-in page end to end: layout on a wide screen, a phone and a landscape phone in both themes;
// the water under the form (drawn, always moving while someone is there, settled after two minutes
// alone, still under reduced motion); password reveal, Caps Lock warning, a refused attempt, the
// language switch and a successful sign-in.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-login-check-'))
const shots = process.env.SILLAGE_SHOTS ?? join(data, 'shots')
const processes = []
const errors = []
let browser

const account = { username: 'alex', displayName: 'Alex', password: 'sillage-demo' }

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
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

/** How much of the water canvas is painted, and a fingerprint of its pixels. */
function readWater(page) {
  return page.locator('canvas.sg-login-water').evaluate((canvas) => {
    const { data: pixels } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    let painted = 0
    let print = 0
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] === 0) continue
      painted++
      print = (print * 31 + pixels[i] + i) % 1000000007
    }
    return { ready: canvas.hasAttribute('data-ready'), painted, print }
  })
}

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n')
  await mkdir(shots, { recursive: true })
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  delete env.NODE_ENV
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  // An account must exist, or every address opens the first-run tour instead of the sign-in page.
  const setup = await fetch(`http://127.0.0.1:${apiPort}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(account),
  })
  assert.equal(setup.status, 201)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })

  async function open({ viewport, mobile = false, theme = 'light', reducedMotion = 'no-preference', locale = 'fr', clock = false }) {
    const context = await browser.newContext({
      viewport,
      isMobile: mobile,
      hasTouch: mobile,
      locale: 'fr-FR',
      colorScheme: theme,
      reducedMotion,
      serviceWorkers: 'block',
    })
    await context.addInitScript(([chosenLocale, chosenTheme]) => {
      localStorage.setItem('sillage.locale', chosenLocale)
      localStorage.setItem('sillage.theme', chosenTheme)
      // Count the frames asked for: on this page, only the water animates.
      window.__frames = 0
      const request = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (callback) => {
        window.__frames++
        return request(callback)
      }
    }, [locale, theme])
    const page = await context.newPage()
    // The page's clock, for checks that would otherwise wait minutes.
    if (clock) await page.clock.install()
    page.on('pageerror', (error) => errors.push(error.message))
    // Any address leads to the sign-in page.
    await page.goto(`${base}/p/quelque-chose`)
    await page.waitForURL(/\/login$/)
    await page.getByRole('heading', { level: 1, name: 'Sillage' }).waitFor()
    await page.waitForFunction(() => document.querySelector('canvas.sg-login-water')?.hasAttribute('data-ready'))
    return { context, page }
  }

  const fields = (page) => ({
    username: page.getByRole('textbox', { name: "Nom d'utilisateur", exact: true }),
    password: page.getByRole('textbox', { name: 'Mot de passe', exact: true }),
    submit: page.getByRole('button', { name: 'Se connecter', exact: true }),
  })

  // Layout: the form above the water, the water down to the bottom edge, nothing wider than the
  // screen, the address shown, focus in the first field only where a keyboard is likely.
  const sizes = [
    { name: 'wide', viewport: { width: 1440, height: 900 }, mobile: false },
    { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
    { name: 'small-phone', viewport: { width: 320, height: 568 }, mobile: true },
  ]
  for (const theme of ['light', 'dark']) {
    for (const size of sizes) {
      const { context, page } = await open({ ...size, theme })
      const { username } = fields(page)
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme)
      await page.getByText(new URL(base).host, { exact: true }).waitFor()
      const layout = await page.evaluate(() => {
        const water = document.querySelector('canvas.sg-login-water').getBoundingClientRect()
        const help = [...document.querySelectorAll('main p')].at(-1).getBoundingClientRect()
        const scroller = document.querySelector('canvas.sg-login-water').closest('.overflow-y-auto')
        return {
          waterTop: water.top + scroller.scrollTop,
          waterBottom: water.bottom + scroller.scrollTop,
          waterHeight: water.height,
          helpBottom: help.bottom + scroller.scrollTop,
          contentHeight: scroller.scrollHeight,
          overflowX: Math.max(document.documentElement.scrollWidth, scroller.scrollWidth) - innerWidth,
          focused: document.activeElement?.getAttribute('name') ?? null,
        }
      })
      assert.ok(layout.overflowX <= 0, `${theme}/${size.name}: nothing wider than the screen`)
      assert.ok(layout.helpBottom <= layout.waterTop, `${theme}/${size.name}: the water stays below the form`)
      assert.ok(Math.abs(layout.waterBottom - layout.contentHeight) <= 1, `${theme}/${size.name}: the water reaches the bottom`)
      assert.ok(layout.waterHeight >= 140, `${theme}/${size.name}: a strip of water worth drawing`)
      assert.equal(layout.focused, size.mobile ? null : 'username', `${theme}/${size.name}: autofocus only with a fine pointer`)
      if (!size.mobile) assert.ok(await username.evaluate((input) => input === document.activeElement))
      const water = await readWater(page)
      assert.ok(water.painted > 1000, `${theme}/${size.name}: the water is drawn`)
      // Let the first pass show before the picture.
      await delay(size.mobile ? 1600 : 2400)
      await page.screenshot({ path: join(shots, `login-${theme}-${size.name}.png`) })
      await context.close()
    }
  }

  // The sea moves while someone is at the page, between passes too; it settles after two minutes
  // without a pointer or a key, the loop stops, and the next sign of life brings it back.
  {
    const { context, page } = await open({ viewport: { width: 390, height: 844 }, mobile: true, clock: true })
    const first = await readWater(page)
    await page.clock.runFor(600)
    assert.notEqual((await readWater(page)).print, first.print, 'the wake moves')
    // Long after the first pass and before the next, the swell and the glints still move.
    await page.clock.runFor(8000)
    const between = await readWater(page)
    await page.clock.runFor(500)
    assert.notEqual((await readWater(page)).print, between.print, 'the sea keeps moving between passes')
    await page.clock.fastForward('02:01')
    await page.clock.runFor(12000)
    const settled = await readWater(page)
    await page.clock.runFor(2000)
    assert.equal((await readWater(page)).print, settled.print, 'the sea settles once nobody is there')
    // A tap on the water is a sign of life, and drops a ring where it lands.
    const box = await page.locator('canvas.sg-login-water').boundingBox()
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.6)
    await page.clock.runFor(800)
    assert.notEqual((await readWater(page)).print, settled.print, 'a tap wakes the sea')
    await context.close()
  }

  // Reduced motion: one still frame with the wake in it, and no animation at all.
  {
    const { context, page } = await open({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', theme: 'dark' })
    const still = await readWater(page)
    assert.ok(still.painted > 1000)
    const frames = await page.evaluate(() => window.__frames)
    await delay(1200)
    assert.equal((await readWater(page)).print, still.print, 'reduced motion: the water does not move')
    assert.equal(await page.evaluate(() => window.__frames), frames, 'reduced motion: no animation frame')
    await page.screenshot({ path: join(shots, 'login-dark-reduced-motion.png') })
    await context.close()
  }

  // A landscape phone is shorter than the page: the page scrolls and the button stays reachable.
  {
    const { context, page } = await open({ viewport: { width: 844, height: 390 }, mobile: true })
    const scroll = await page.locator('.overflow-y-auto').first().evaluate((scroller) => scroller.scrollHeight - scroller.clientHeight)
    assert.ok(scroll > 0, 'landscape: the page scrolls')
    await fields(page).submit.scrollIntoViewIfNeeded()
    assert.ok(await fields(page).submit.isVisible())
    await context.close()
  }

  // The form itself, on a wide screen.
  {
    const { context, page } = await open({ viewport: { width: 1440, height: 900 } })
    const { username, password, submit } = fields(page)

    // Reveal and hide the password; the button says what it will do.
    await password.fill('sillage')
    await page.getByRole('button', { name: 'Afficher le mot de passe' }).click()
    assert.equal(await password.getAttribute('type'), 'text')
    await page.getByRole('button', { name: 'Masquer le mot de passe' }).click()
    assert.equal(await password.getAttribute('type'), 'password')

    // Caps Lock: warned while it is on, quiet once it is off or the field is left.
    await password.focus()
    await password.evaluate((input) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true, modifierCapsLock: true })))
    await page.getByText('Verr. Maj est activé.').waitFor()
    await password.evaluate((input) => input.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true })))
    await page.getByText('Verr. Maj est activé.').waitFor({ state: 'detached' })

    // A refused attempt: the reason is shown, the password is selected to be typed again, and
    // the message goes as soon as it is.
    await username.fill(account.username)
    await password.fill('not-the-password')
    await submit.click()
    const refused = page.getByRole('alert').filter({ hasText: 'Identifiant ou mot de passe incorrect.' })
    await refused.waitFor()
    await page.waitForFunction(() => {
      const input = document.activeElement
      return input instanceof HTMLInputElement && input.name === 'password' && input.selectionStart === 0 && input.selectionEnd === input.value.length
    })
    await page.screenshot({ path: join(shots, 'login-light-refused.png') })
    await page.keyboard.type('x')
    assert.equal(await password.inputValue(), 'x')
    await refused.waitFor({ state: 'detached' })

    // The language can be changed before signing in.
    await page.getByRole('button', { name: 'English' }).click()
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
    await page.getByRole('textbox', { name: 'Username', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Français' }).click()
    await submit.waitFor()

    // The right password opens the account: here a new one, so its first-run tour.
    await password.fill(account.password)
    await password.press('Enter')
    await page.waitForURL(/\/bienvenue$/)
    await context.close()
  }

  assert.deepEqual(errors, [])
  console.log(`OK: sign-in layout (3 sizes × 2 themes), water motion, rest and reduced motion, landscape scroll, form behaviour. Pictures in ${shots}`)
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  if (!process.env.SILLAGE_SHOTS) await rm(data, { recursive: true, force: true })
  else await rm(join(data, 'data'), { recursive: true, force: true })
}
