import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { _electron as electron } from 'playwright'

/**
 * End-to-end update check: an installed version A discovers version B in a local
 * HTTP feed, downloads it, exposes Restart and update in About, and replaces and
 * relaunches itself after confirmation.
 * Usage: node scripts/desktop-update-check.mjs --app <executable of A> --feed <B directory>
 * Use an installed NSIS app on Windows, a writable .app on macOS, or an AppImage /
 * installed .deb on Linux (under Xvfb). The feed contains packages and latest*.yml.
 * The check uses a disposable SILLAGE_DESKTOP_USER_DATA directory.
 * On Linux, APPIMAGE=<file> lets an AppArmor-covered unpacked executable exercise
 * file replacement where an extracted AppImage cannot retain its sandbox.
 */
const { values } = parseArgs({ options: { app: { type: 'string' }, feed: { type: 'string' } } })
if (!values.app || !values.feed) {
  console.error('usage: node scripts/desktop-update-check.mjs --app <exécutable> --feed <dossier>')
  process.exit(1)
}
const executable = resolve(values.app)
const feed = resolve(values.feed)
const bundle = process.platform === 'darwin' ? resolve(executable, '..', '..', '..') : null
const appImage = process.env.APPIMAGE ? resolve(process.env.APPIMAGE) : executable

const channelFile =
  process.platform === 'darwin'
    ? 'latest-mac.yml'
    : process.platform === 'win32'
      ? 'latest.yml'
      : process.arch === 'arm64'
        ? 'latest-linux-arm64.yml'
        : 'latest-linux.yml'
const channel = readFileSync(join(feed, channelFile), 'utf8')
const target = /^version: (.+)$/m.exec(channel)?.[1]?.trim()
assert.ok(target, `pas de version dans ${channelFile}`)
// AppImages have no external version field; verify the installed file against the feed hash.
const appImageSha512 = /- url: \S+\.AppImage\s+sha512: (\S+)/.exec(channel)?.[1]

function sha512(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function installedVersion() {
  if (bundle) {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(bundle, 'Contents', 'Info.plist')], {
      encoding: 'utf8',
    }).trim()
  }
  if (process.platform === 'win32') {
    // The executable is briefly absent during replacement; Windows uses four version parts.
    const script = `(Get-Item -LiteralPath '${executable}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion`
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
      .trim()
      .replace(/^(\d+\.\d+\.\d+)\.0$/, '$1')
  }
  const debPackage = ownerPackage(executable)
  if (debPackage) return execFileSync('dpkg-query', ['-W', '-f=${Version}', debPackage], { encoding: 'utf8' }).trim()
  return existsSync(appImage) && sha512(appImage) === appImageSha512 ? target : 'autre'
}

/** Find the .deb owning this executable, if any. */
function ownerPackage(file) {
  try {
    return execFileSync('dpkg', ['-S', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(':')[0].trim()
  } catch {
    return null
  }
}

/** Find installed application processes, including the relaunched window, excluding helpers. */
function appProcesses() {
  if (process.platform === 'win32') {
    // PowerShell otherwise exits with an error when there are no matching processes.
    const script = `Get-Process -Name Sillage -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${executable}' } | ForEach-Object { $_.Id }; exit 0`
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number)
  }
  // AppImages relaunch from a mount point: match the binary name on Linux, the executable on macOS.
  const lines = execFileSync('ps', [bundle ? '-axo' : '-eo', 'pid=,comm=,args='], { encoding: 'utf8' }).split('\n')
  return lines
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match) => match && (bundle ? match[3].startsWith(executable) : match[2] === 'sillage' && !match[3].includes('--type=')))
    .map((match) => Number(match[1]))
}

async function waitFor(what, test, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await test()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`)
    await delay(1000)
  }
}

// Serve version B like a release feed.
const server = createServer((req, res) => {
  const file = join(feed, decodeURIComponent(new URL(req.url, 'http://feed').pathname))
  if (!file.startsWith(feed + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-length': statSync(file).size })
  createReadStream(file).pipe(res)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const feedUrl = `http://127.0.0.1:${server.address().port}/`

const scratch = await mkdtemp(join(tmpdir(), 'sillage-update-check-'))
const userData = join(scratch, 'user-data')
const shots = join(scratch, 'shots')
await mkdir(shots)
let app
let page

try {
  const before = installedVersion()
  assert.notEqual(before, target, `l'app installée est déjà en ${target}`)
  console.log(`app installée : ${before}, version proposée : ${target}`)

  app = await electron.launch({
    executablePath: executable,
    env: { ...process.env, SILLAGE_DESKTOP_USER_DATA: userData, SILLAGE_DESKTOP_UPDATE_FEED: feedUrl },
    // Otherwise Playwright disables the Linux sandbox, which the relaunched app would inherit.
    chromiumSandbox: true,
    timeout: 120_000,
  })
  const exited = new Promise((done) => app.process().once('exit', done))
  page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForURL(/\/bienvenue$/, { timeout: 60_000 })
  await page.getByRole('button', { name: /Passer la visite|Skip the tour/ }).click()
  await page.getByRole('heading', { level: 1, name: /C’est prêt\.|All set\./ }).waitFor()
  await page.getByRole('button', { name: /Créer mon premier projet|Create my first project/ }).click()
  await page.waitForURL(/\/projects\/new$/)
  await page.goto(new URL('/settings/a-propos', page.url()).href)

  // Trigger the startup check immediately instead of waiting ten seconds.
  await page.evaluate(() => window.sillageDesktop.updates.check())
  const seen = []
  const ready = await waitFor(
    'version prête',
    async () => {
      const state = await page.evaluate(() => window.sillageDesktop.updates.state())
      if (seen.at(-1) !== state.status) seen.push(state.status)
      if (state.status === 'error' || state.status === 'unsupported') throw new Error(`mise à jour : ${JSON.stringify(state)}`)
      return state.status === 'ready' ? state : null
    },
    600_000,
  )
  console.log(`états : ${seen.join(' → ')}`)
  assert.equal(ready.version, target)

  const install = page.getByRole('button', { name: /Redémarrer et mettre à jour|Restart and update/ })
  await install.waitFor()
  await page.screenshot({ path: join(shots, 'about-ready.png'), fullPage: true })
  await install.click()
  await page.getByRole('dialog').getByRole('button', { name: /Redémarrer et mettre à jour|Restart and update/ }).click()

  await Promise.race([
    exited,
    delay(120_000, undefined, { ref: false }).then(() => {
      throw new Error("l'app ne s'est pas fermée pour s'installer")
    }),
  ])
  app = null
  page = null
  console.log('app fermée pour la mise à jour')

  await waitFor(`app installée en ${target}`, () => installedVersion() === target, 300_000)
  console.log(`app installée en ${target}`)
  if (bundle) {
    // The swap script writes its result immediately after replacement.
    const result = join(userData, 'update-result')
    await waitFor("verdict de l'échange", () => existsSync(result), 30_000)
    assert.equal(readFileSync(result, 'utf8').trim(), 'ok')
  }

  const relaunched = await waitFor('app relancée', () => appProcesses().length > 0 && appProcesses(), 120_000)
  console.log(`app relancée (process ${relaunched.join(', ')})`)
  await waitFor('relaunched server healthy', async () => {
    const { port } = JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8'))
    return fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((response) => response.ok).catch(() => false)
  }, 120_000)
  console.log('contrôle de mise à jour réussi (serveur relancé et disponible)')
} catch (err) {
  await page?.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {})
  const log = join(userData, 'logs', 'updater.log')
  if (existsSync(log)) console.log(`--- updater.log\n${readFileSync(log, 'utf8')}`)
  console.log(`captures : ${shots}`)
  throw err
} finally {
  await app?.close().catch(() => {})
  server.close()
  for (const pid of appProcesses()) {
    try {
      process.kill(pid)
    } catch {
      // Already exited.
    }
  }
  if (process.env.KEEP_DESKTOP_CHECK !== '1') await rm(scratch, { recursive: true, force: true }).catch(() => {})
}
