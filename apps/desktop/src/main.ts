import { delimiter, dirname, join } from 'node:path'
import { BrowserWindow, app, dialog, session, shell } from 'electron'
import { stablePort } from './port'
import { startServer, type RunningServer } from './server'
import { loginShellEnv, pathKey } from './shell-env'
import { text } from './texts'
import { setupUpdates } from './updates'

/**
 * Desktop application's main process.
 *
 * Starts the release Sillage server with bundled Node, sets its returned session
 * as a cookie, and displays the served interface in a window. Everything else is
 * the same web app as a hosted instance, adapting screens to the server's
 * announced `desktop` profile.
 */

/** Must match `SESSION_COOKIE` (apps/server/src/auth/sessions.ts). */
const SESSION_COOKIE = 'sillage_session'

/** App background prevents a white flash before the first render. */
const BACKGROUND = '#0b0d1c'

let server: RunningServer | null = null
let origin = ''
let quitting = false
/** Retain startup settings for recovery after a crash or failed installation. */
let launchSettings: { env: NodeJS.ProcessEnv; port: number } | null = null

// Disposable launch-check profile (scripts/desktop-ui-check.mjs), leaving user
// projects/settings untouched. Set before reading any path.
// On Windows use AppData\Local instead of Roaming: databases can weigh gigabytes,
// and roaming profiles would copy them at every sign-in.
if (process.env.SILLAGE_DESKTOP_USER_DATA) app.setPath('userData', process.env.SILLAGE_DESKTOP_USER_DATA)
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', join(process.env.LOCALAPPDATA, 'Sillage'))
const userData = app.getPath('userData')
const logFile = join(userData, 'logs', 'server.log')

// Packaged apps find server and Node in resources; repository launches use
// `stage/`, populated by `scripts/desktop-stage.mjs`.
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'stage')
const node =
  process.platform === 'win32' ? join(resources, 'node', 'node.exe') : join(resources, 'node', 'bin', 'node')

// Single instance: two servers on one database would compete for scheduler and
// board sync, and the second would open another port without the first's drafts
// or preferences.
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
  // Bundled Node/npm are fallbacks: user-maintained ones take precedence, but
  // Sillage can install and launch a CLI on an otherwise empty machine.
  const key = pathKey(env)
  env[key] = [env[key], dirname(node)].filter(Boolean).join(delimiter)
  const port = await stablePort(join(userData, 'desktop.json'))
  launchSettings = { env, port }

  await launch(launchSettings)
  setupUpdates({
    userData,
    logDir: dirname(logFile),
    isAppUrl,
    stopServer,
    restartServer: async () => {
      if (launchSettings) await relaunchServer(launchSettings)
    },
  })
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
  // No expiration: the cookie does not outlive the app, and the server opens a new
  // session on every launch.
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

/** Report a server crash during use and offer to restart it. */
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
  await relaunchServer(settings)
}

async function relaunchServer(settings: { env: NodeJS.ProcessEnv; port: number }): Promise<void> {
  try {
    await launch(settings)
    for (const win of BrowserWindow.getAllWindows()) win.reload()
  } catch (err) {
    fatal(err)
  }
}

/** Stop the server without quitting or reporting its exit as a crash. */
async function stopServer(): Promise<void> {
  const running = server
  server = null
  await running?.stop()
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  })
  win.once('ready-to-show', () => win.show())
  void win.loadURL(origin)
}

// Keep interface links in app windows; everything else opens in the system browser.
// Applied to every created content, including child windows.
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

/** Pages and email only: agent-written links cannot open files or applications. */
function openExternal(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url)
}

// On macOS, closing the window leaves the app and sessions running, as expected
// on that system, and the Dock reopens it. Elsewhere, closing the last window quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && origin) openWindow()
})

// Quitting stops the server as its service would: clean up active sessions and
// close the database instead of leaving orphaned CLIs.
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
