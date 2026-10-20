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
 * La mise à jour de l'app de bureau, de bout en bout. Une app installée, la version A,
 * trouve dans un dossier servi en HTTP une version plus récente, B : elle la télécharge et
 * la montre prête dans « À propos ». Au clic sur « Redémarrer et mettre à jour », elle se
 * ferme, se remplace et se relance en version B.
 *
 * Usage : node scripts/desktop-update-check.mjs --app <exécutable de A> --feed <dossier de B>
 *   - Linux : l'AppImage de A, dans un dossier où elle peut être remplacée, ou l'exécutable
 *     qu'a installé son paquet .deb (/opt/Sillage/sillage), mis à jour par sudo (sous
 *     xvfb-run dans les deux cas) ;
 *   - macOS : Sillage.app/Contents/MacOS/Sillage, l'app décompressée dans un dossier
 *     inscriptible ;
 *   - Windows : le Sillage.exe que l'installeur NSIS de A a installé.
 * Le dossier de B contient ses paquets et le latest*.yml qu'electron-builder a écrits à
 * côté. Le profil de l'app va dans un dossier temporaire (SILLAGE_DESKTOP_USER_DATA).
 *
 * Sous Linux, APPIMAGE=<fichier> fait passer l'exécutable donné pour cette AppImage :
 * l'updater remplace le fichier, et le contrôle vérifie celui-ci. C'est ainsi qu'on
 * l'essaie là où une AppImage ne peut pas garder son bac à sable (Ubuntu 24.04 et plus),
 * en lançant le dossier décompressé, couvert par un profil AppArmor.
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
// L'AppImage n'a pas de version lisible du dehors : remplacée, elle a l'empreinte que le
// fichier de canal annonce pour elle.
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
    // Absent le temps que l'installeur le remplace ; sa version a quatre parties (0.0.2.0).
    const script = `(Get-Item -LiteralPath '${executable}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion`
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
      .trim()
      .replace(/^(\d+\.\d+\.\d+)\.0$/, '$1')
  }
  const debPackage = ownerPackage(executable)
  if (debPackage) return execFileSync('dpkg-query', ['-W', '-f=${Version}', debPackage], { encoding: 'utf8' }).trim()
  return existsSync(appImage) && sha512(appImage) === appImageSha512 ? target : 'autre'
}

/** Le paquet .deb qui a installé ce fichier, s'il y en a un. */
function ownerPackage(file) {
  try {
    return execFileSync('dpkg', ['-S', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(':')[0].trim()
  } catch {
    return null
  }
}

/** Les process de l'app installée, la fenêtre relancée comprise, mais pas ses auxiliaires. */
function appProcesses() {
  if (process.platform === 'win32') {
    const script = `Get-Process -Name Sillage -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${executable}' } | ForEach-Object { $_.Id }`
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number)
  }
  // Sous Linux, l'AppImage relancée tourne depuis son point de montage : c'est le nom du
  // binaire, `sillage`, qui la désigne. Sous macOS, le chemin de l'exécutable.
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

// Le dossier de B, servi comme le serait une release GitHub.
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
    // Sans quoi Playwright ajoute `--no-sandbox` sous Linux, et la relance en hériterait.
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

  // L'app cherche d'elle-même dix secondes après le lancement ; on n'attend pas.
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
    delay(120_000).then(() => {
      throw new Error("l'app ne s'est pas fermée pour s'installer")
    }),
  ])
  app = null
  page = null
  console.log('app fermée pour la mise à jour')

  await waitFor(`app installée en ${target}`, () => installedVersion() === target, 300_000)
  console.log(`app installée en ${target}`)
  if (bundle) {
    // Le verdict du script d'échange, qui l'écrit juste après avoir mis la nouvelle app en place.
    const result = join(userData, 'update-result')
    await waitFor("verdict de l'échange", () => existsSync(result), 30_000)
    assert.equal(readFileSync(result, 'utf8').trim(), 'ok')
  }

  const relaunched = await waitFor('app relancée', () => appProcesses().length > 0 && appProcesses(), 120_000)
  console.log(`app relancée (process ${relaunched.join(', ')})`)
  console.log('contrôle de mise à jour réussi')
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
      // Déjà sorti.
    }
  }
  if (process.env.KEEP_DESKTOP_CHECK !== '1') await rm(scratch, { recursive: true, force: true }).catch(() => {})
}
