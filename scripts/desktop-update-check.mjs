import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { _electron as electron } from 'playwright'

/**
 * End-to-end update check: an installed version A discovers version B in a local
 * HTTP feed, downloads it, exposes Restart and update in About, and replaces and
 * relaunches itself after confirmation. On Windows, B's installer is then run by hand
 * over the installation, twice: over the open app, and over what a closed one left running.
 * Usage: node scripts/desktop-update-check.mjs --app <executable of A> --feed <B directory>
 * Use an installed NSIS app on Windows, a writable .app on macOS, or an AppImage /
 * installed .deb on Linux (under Xvfb). The feed contains packages and latest*.yml.
 * The check uses a disposable SILLAGE_DESKTOP_USER_DATA directory. Windows
 * requires an unused default profile: a temporary junction keeps that profile
 * isolated when NSIS relaunches through the shell without the test environment.
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
let profileLink
let launchAttempted = false
/** Stand-in for a CLI the server left running under the bundled Node (Windows). */
let leftover = null
let leftoverExited = false

function startLeftover() {
  const node = join(dirname(executable), 'resources', 'node', 'node.exe')
  leftoverExited = false
  leftover = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true })
  leftover.on('exit', () => {
    leftoverExited = true
  })
  leftover.unref()
  console.log(`processus résiduel lancé depuis le dossier d'installation (${leftover.pid})`)
  return leftover.pid
}

/**
 * Windows: someone downloads the installer and runs it over their installation. The
 * installer has to free the directory itself then (apps/desktop/resources/installer.nsh):
 * close an open Sillage in order, and stop what a closed one left running rather than
 * ask to close an application nobody can see.
 */
async function reinstallByHand() {
  const installer = join(feed, /^path: (.+)$/m.exec(channel)?.[1]?.trim() ?? '')
  assert.ok(existsSync(installer) && statSync(installer).isFile(), `no installer named in ${channelFile}`)
  // The installer of the update tidies up for a few seconds after it relaunched the app,
  // and a second installer leaves at once (code 2) rather than run beside it.
  const running = () => {
    const script = `Get-Process -Name '${basename(installer, '.exe')}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }; exit 0`
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).split(/\s+/).filter(Boolean)
  }
  const since = Date.now()
  const first = running()
  await waitFor('the installer of the update to finish', () => running().length === 0, 120_000)
  console.log(first.length > 0
    ? `installer of the update (${first.join(', ')}) gone ${Math.round((Date.now() - since) / 1000)} s after the relaunch`
    : 'installer of the update already gone')
  // Replacing the installation starts by removing its directory: a file of ours that is
  // gone says the previous one really went, which the unchanged version cannot.
  const marker = join(dirname(executable), 'reinstall-check')
  const installerLog = () => readFileSync(join(userData, 'logs', 'installer.log'), 'utf8')
  const reinstall = async (what) => {
    writeFileSync(marker, '')
    // Silent, as in the workflow: the installer then answers its own questions.
    const setup = spawn(installer, ['/S'], { stdio: 'ignore' })
    const code = await Promise.race([
      new Promise((done, fail) => setup.once('exit', done).once('error', fail)),
      delay(180_000, undefined, { ref: false }).then(() => {
        setup.kill()
        throw new Error(`${what}: the installer did not finish`)
      }),
    ])
    assert.equal(code, 0, `${what}: the installer exited with ${code} (installers running: ${running().join(', ') || 'none'})`)
    assert.ok(!existsSync(marker), `${what}: the previous installation was not removed`)
    assert.equal(installedVersion(), target, `${what}: no application after the installer`)
    console.log(`${what}: reinstalled`)
  }

  assert.ok(appProcesses().length > 0, 'the relaunched app should still be open')
  await reinstall('over the open app')
  assert.equal(appProcesses().length, 0, 'the installer should have closed the app')
  assert.match(installerLog(), /close: running from /)
  // Closed through its window, the app quits in order; the installer only stops what stays.
  assert.doesNotMatch(installerLog(), /stopping Sillage\.exe/, 'the app was stopped instead of closed')

  const pid = startLeftover()
  await reinstall('over a leftover process')
  await waitFor('leftover process stopped by the installer', () => leftoverExited, 30_000)
  assert.match(installerLog(), new RegExp(`stopping node\\.exe \\(${pid}\\)`))
}

try {
  if (process.platform === 'win32') {
    assert.ok(process.env.LOCALAPPDATA, 'LOCALAPPDATA is required for the isolated update check')
    assert.equal(appProcesses().length, 0, 'Close the installed app before running the update check')
    await mkdir(userData, { recursive: true })
    const destination = join(process.env.LOCALAPPDATA, 'Sillage')
    // Never replace an existing user profile. NSIS uses ExecShellAsUser, whose
    // new process need not inherit SILLAGE_DESKTOP_USER_DATA from Playwright.
    await symlink(userData, destination, 'junction')
    profileLink = destination
  }
  const before = installedVersion()
  assert.notEqual(before, target, `l'app installée est déjà en ${target}`)
  console.log(`app installée : ${before}, version proposée : ${target}`)

  launchAttempted = true
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
  if (process.platform === 'win32') {
    // NSIS refuses to replace files a process still holds and asks the user to close it:
    // the app must stop what still runs from its directory before handing over.
    startLeftover()
  }
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
  if (leftover) {
    await waitFor('processus résiduel arrêté par l’app', () => leftoverExited, 30_000)
    console.log('processus résiduel arrêté avant l’installation')
  }

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
  if (process.platform === 'win32') await reinstallByHand()
} catch (err) {
  await page?.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {})
  for (const name of ['updater.log', 'installer.log', 'server.log', 'performance.jsonl']) {
    const log = join(userData, 'logs', name)
    if (existsSync(log)) console.log(`--- ${name}\n${readFileSync(log, 'utf8').slice(-16000)}`)
  }
  console.log(`captures : ${shots}`)
  throw err
} finally {
  await app?.close().catch(() => {})
  server.close()
  for (const pid of [...(launchAttempted ? appProcesses() : []), ...(leftover && !leftoverExited ? [leftover.pid] : [])]) {
    try {
      process.kill(pid)
    } catch {
      // Already exited.
    }
  }
  // Unlink only the junction created by this run; never recurse into a profile.
  if (profileLink) await unlink(profileLink)
  if (process.env.KEEP_DESKTOP_CHECK !== '1') await rm(scratch, { recursive: true, force: true }).catch(() => {})
}
