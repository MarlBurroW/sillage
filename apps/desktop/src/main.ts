import { delimiter, dirname, join } from 'node:path'
import { BrowserWindow, app, dialog, session, shell } from 'electron'
import { stablePort } from './port'
import { startServer, type RunningServer } from './server'
import { loginShellEnv, pathKey } from './shell-env'
import { text } from './texts'

/**
 * Processus principal de l'application de bureau.
 *
 * Il lance le serveur de Sillage, celui des releases, avec le Node embarqué ; pose en
 * cookie la session que ce serveur lui remet ; et montre dans une fenêtre l'interface
 * qu'il sert. Tout le reste est l'application web, la même que sur une instance
 * hébergée, qui adapte ses écrans au profil `desktop` que le serveur lui annonce.
 */

/** Doit rester le nom de `SESSION_COOKIE` (apps/server/src/auth/sessions.ts). */
const SESSION_COOKIE = 'sillage_session'

/** Le fond de l'application, pour qu'aucun éclair blanc ne précède le premier rendu. */
const BACKGROUND = '#0b0d1c'

let server: RunningServer | null = null
let origin = ''
let quitting = false

// Un profil jetable pour le contrôle de lancement (scripts/desktop-ui-check.mjs), qui ne
// touche ni aux projets ni aux réglages de l'utilisateur. Avant toute lecture du chemin.
// Sous Windows, dans AppData\Local plutôt que Roaming : la base peut peser des gigaoctets,
// et un profil itinérant la recopierait à chaque ouverture de session.
if (process.env.SILLAGE_DESKTOP_USER_DATA) app.setPath('userData', process.env.SILLAGE_DESKTOP_USER_DATA)
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', join(process.env.LOCALAPPDATA, 'Sillage'))
const userData = app.getPath('userData')
const logFile = join(userData, 'logs', 'server.log')

// Empaquetée, l'app trouve le serveur et Node dans ses ressources ; lancée depuis le
// dépôt, dans `stage/`, que remplit `scripts/desktop-stage.mjs`.
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'stage')
const node =
  process.platform === 'win32' ? join(resources, 'node', 'node.exe') : join(resources, 'node', 'bin', 'node')

// Une seule instance : deux serveurs sur la même base se disputeraient le planificateur et
// la synchro du board, et le second ouvrirait sa page sur un autre port, donc sans les
// brouillons ni les préférences du premier.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      if (origin) openWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(boot).catch(fatal)
}

async function boot(): Promise<void> {
  const locale = app.getSystemLocale().replace('-', '_')
  const env = await loginShellEnv(node, locale.includes('_') ? `${locale}.UTF-8` : 'en_US.UTF-8')
  // Node et npm embarqués en dernier recours : ceux que l'utilisateur maintient passent
  // devant, mais Sillage peut installer un CLI et le lancer sur un poste qui n'a rien.
  const key = pathKey(env)
  env[key] = [env[key], dirname(node)].filter(Boolean).join(delimiter)
  const port = await stablePort(join(userData, 'desktop.json'))

  await launch({ env, port })
  openWindow()
}

async function launch({ env, port }: { env: NodeJS.ProcessEnv; port: number }): Promise<void> {
  const started = startServer({
    node,
    runtime: join(resources, 'sillage'),
    dataDir: join(userData, 'data'),
    configFile: join(userData, 'config.toml'),
    logFile,
    port,
    env,
  })
  server = started
  const handshake = await started.ready
  origin = handshake.origin
  // Sans date d'expiration : le cookie ne survit pas à l'app, et le serveur ouvre une
  // session neuve à chaque lancement.
  await session.defaultSession.cookies.set({
    url: origin,
    name: SESSION_COOKIE,
    value: handshake.session,
    httpOnly: true,
    sameSite: 'lax',
  })
  started.onExit((code) => {
    if (quitting || server !== started) return
    server = null
    void stopped(code, { env, port })
  })
}

/** Le serveur est tombé en cours de route : le dire, et proposer de le relancer. */
async function stopped(code: number | null, settings: { env: NodeJS.ProcessEnv; port: number }): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: text('stopped'),
    detail: text('stoppedDetail', { code: String(code), log: logFile }),
    buttons: [text('restart'), text('quit')],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) {
    app.quit()
    return
  }
  try {
    await launch(settings)
    for (const win of BrowserWindow.getAllWindows()) win.reload()
  } catch (err) {
    fatal(err)
  }
}

function openWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Sillage',
    backgroundColor: BACKGROUND,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  })
  win.once('ready-to-show', () => win.show())
  void win.loadURL(origin)
}

// Les liens : l'interface reste dans ses fenêtres, tout le reste part dans le navigateur
// du système. Posé sur chaque contenu créé, fenêtres filles comprises.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' }
    openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternal(url)
  })
})

function isAppUrl(url: string): boolean {
  try {
    return origin !== '' && new URL(url).origin === origin
  } catch {
    return false
  }
}

/** Une page ou un courriel, rien d'autre : un lien écrit par un agent n'ouvre ni fichier ni application. */
function openExternal(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url)
}

// Sur macOS, fermer la fenêtre laisse l'app et ses sessions tourner, comme le veut ce
// système, et le Dock la rouvre. Ailleurs, la dernière fenêtre fermée quitte l'app.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && origin) openWindow()
})

// Quitter arrête le serveur comme le ferait son service : il range les sessions en cours
// et ferme la base, au lieu de laisser des CLI orphelins.
app.on('before-quit', (event) => {
  if (!server) return
  event.preventDefault()
  quitting = true
  const running = server
  server = null
  void running.stop().finally(() => app.quit())
})

function fatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  dialog.showErrorBox(text('startFailed'), `${message}\n\n${text('seeLog', { log: logFile })}`)
  quitting = true
  void (server?.stop() ?? Promise.resolve()).finally(() => app.exit(1))
}
