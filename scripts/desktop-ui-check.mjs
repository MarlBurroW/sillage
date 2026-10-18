import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

/**
 * L'application de bureau empaquetée, lancée pour de vrai : son serveur démarre, la
 * fenêtre s'ouvre sans page de connexion, les écrans réservés au serveur hébergé ont
 * disparu, le serveur refuse ce qui ne vient pas de la fenêtre, et quitter l'arrête.
 *
 * Le profil de l'app (base, réglages, journal) va dans un dossier temporaire, par
 * SILLAGE_DESKTOP_USER_DATA. Sous Linux, il faut un écran (xvfb-run) et, là où les
 * namespaces sont restreints (Ubuntu 24.04+), un profil AppArmor pour l'exécutable testé.
 *
 * Usage : node scripts/desktop-ui-check.mjs [exécutable]
 * (par défaut celui que produit electron-builder pour la plateforme courante :
 * apps/desktop/release/linux-unpacked/sillage, ou
 * apps/desktop/release/mac-arm64/Sillage.app/Contents/MacOS/Sillage)
 */
const root = fileURLToPath(new URL('../', import.meta.url))
const executable =
  process.argv[2] ??
  join(
    root,
    process.platform === 'darwin'
      ? `apps/desktop/release/mac-${process.arch}/Sillage.app/Contents/MacOS/Sillage`
      : 'apps/desktop/release/linux-unpacked/sillage',
  )
const scratch = await mkdtemp(join(tmpdir(), 'sillage-desktop-check-'))
const userData = join(scratch, 'user-data')
const shots = join(scratch, 'shots')
await mkdir(shots)
let app

/** Une requête HTTP brute, pour forger `Host` et `Origin` comme le ferait une page hostile. */
function raw(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

async function listening(port) {
  return raw(port, '/api/health', { host: `127.0.0.1:${port}` }).then(
    () => true,
    () => false,
  )
}

try {
  app = await electron.launch({
    executablePath: executable,
    env: { ...process.env, SILLAGE_DESKTOP_USER_DATA: userData },
    timeout: 120_000,
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForLoadState('domcontentloaded')
  // La coque de l'application, signe que la session est ouverte.
  await page.getByRole('link', { name: /Paramètres|Settings/ }).first().waitFor({ timeout: 60_000 })

  const url = new URL(page.url())
  assert.equal(url.hostname, '127.0.0.1', `fenêtre sur ${page.url()}`)
  assert.notEqual(url.pathname, '/login', 'la fenêtre ne doit jamais montrer la connexion')
  const port = Number(url.port)

  const instance = await page.evaluate(() => fetch('/api/system/instance').then((response) => response.json()))
  assert.equal(instance.profile, 'desktop')
  assert.deepEqual(instance.capabilities, { passwordAuth: false, webPush: false, pwa: false })
  const version = await page.evaluate(() => fetch('/api/system/version').then((response) => response.json()))
  assert.equal(version.channel, 'desktop')

  assert.equal(await page.getByText(/Se déconnecter|Log out/).count(), 0, 'pas de déconnexion sans mot de passe')
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((list) => list.length)),
    0,
    'aucun service worker en bureau',
  )
  await page.screenshot({ path: join(shots, 'home.png') })

  await page.goto(new URL('/settings', url).href)
  await page.getByRole('link', { name: /Apparence|Appearance/ }).first().waitFor()
  for (const hidden of [/^(Compte|Account)$/, /^Notifications$/, /^(Comptes|Accounts)$/]) {
    assert.equal(await page.getByRole('link', { name: hidden }).count(), 0, `catégorie ${hidden} masquée`)
  }
  await page.screenshot({ path: join(shots, 'settings.png') })

  // Seule la fenêtre parle au serveur : une autre origine, un autre `Host` (DNS
  // rebinding), une WebSocket ouverte depuis une autre page locale, tout est refusé.
  const host = `127.0.0.1:${port}`
  assert.equal(await raw(port, '/api/health', { host }), 200)
  assert.equal(await raw(port, '/api/health', { host: `attacker.example:${port}` }), 403)
  assert.equal(await raw(port, '/api/auth/me', { host, origin: 'http://127.0.0.1:5173' }), 403)
  assert.equal(
    await raw(port, '/api/ws', {
      host,
      origin: 'http://localhost:3000',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    }),
    403,
  )

  // La session a transité par le tube du lanceur, jamais par le journal.
  const log = await readFile(join(userData, 'logs/server.log'), 'utf8')
  const cookie = (await page.context().cookies()).find((entry) => entry.name === 'sillage_session')
  assert.ok(cookie, 'cookie de session posé par le lanceur')
  assert.ok(!log.includes(cookie.value), 'la session ne doit pas apparaître dans le journal')

  await app.close()
  app = undefined
  for (let i = 0; i < 50 && (await listening(port)); i++) await delay(200)
  assert.equal(await listening(port), false, 'quitter l’app arrête son serveur')

  console.log(`desktop-ui-check : ok (captures dans ${shots})`)
} finally {
  await app?.close().catch(() => {})
  if (process.env.KEEP_DESKTOP_CHECK !== '1') await rm(scratch, { recursive: true, force: true })
}
