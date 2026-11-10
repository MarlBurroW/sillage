import { setupWindowChrome, windowChromeOptions } from './window-chrome'
import { setupDiagnostics } from './diagnostics'
import type { DiagnosticLog } from './diagnostic-log'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserWindow, app, dialog, nativeTheme, session, shell } from 'electron'
import { releaseInstallDir } from './install-dir'
import { stablePort } from './port'
import { ServerStartError, startServer, type RunningServer } from './server'
import { loginShellEnv, pathKey } from './shell-env'
import { text } from './texts'
import { fileLogger, setupUpdates } from './updates'

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

/**
 * The startup page's background (public/splash.html), which follows the system theme:
 * a window created in another colour flashes before its first paint.
 */
const BACKGROUND = { dark: '#0b0d1c', light: '#f7f7fb' }

/** A server that exits at once is often the previous one still letting go of the port or database. */
const RETRY_PAUSE_MS = 2_000
/** After the cleanup, exit even if a page refuses to unload. */
const QUIT_GRACE_MS = 5_000
/** Leftover processes die on taskkill; this mostly covers PowerShell listing them. */
const LEAVE_TIMEOUT_MS = 6_000

/** Where to get a fresh package when this installation no longer starts. */
const DOWNLOAD_URL =
  process.platform === 'win32'
    ? 'https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-win-x64.exe'
    : process.platform === 'darwin'
      ? 'https://github.com/MarlBurroW/sillage/releases/latest/download/Sillage-mac-arm64.dmg'
      : 'https://github.com/MarlBurroW/sillage/releases/latest'

interface LaunchSettings {
  env: NodeJS.ProcessEnv
  port: number
}

let diagnostics: DiagnosticLog | null = null
let server: RunningServer | null = null
let origin = ''
/** The server at `origin` answers: windows can load the interface. */
let serving = false
let quitting = false
/** Retain startup settings for recovery after a crash or failed installation. */
let launchSettings: LaunchSettings | null = null
/** The start in flight: crash recovery, a failed update and a resumed quit may all ask for one. */
let starting: Promise<void> | null = null
/** Quit, first phase: windows are gone and the server is being stopped. */
let stopping = false
/** The app was launched again during that phase. */
let reopened = false
/** Quit, second phase: the cleanup is done and the process is leaving. */
let quitNow = false
/** An installer takes over and reopens the app itself. */
let installing = false
let relaunched = false
let interfaceTimed = false

// Disposable launch-check profile (scripts/desktop-ui-check.mjs), leaving user
// projects/settings untouched. Set before reading any path.
// On Windows use AppData\Local instead of Roaming: databases can weigh gigabytes,
// and roaming profiles would copy them at every sign-in.
if (process.env.SILLAGE_DESKTOP_USER_DATA) app.setPath('userData', process.env.SILLAGE_DESKTOP_USER_DATA)
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', join(process.env.LOCALAPPDATA, 'Sillage'))
const userData = app.getPath('userData')
const logFile = join(userData, 'logs', 'server.log')
const portFile = join(userData, 'desktop.json')

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
    if (installing) return
    if (stopping) {
      reopen()
      return
    }
    if (quitNow) {
      // Too late to stay: start again once this process is gone.
      if (!relaunched) app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) } : undefined)
      relaunched = true
      return
    }
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      if (origin && !quitting) openWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(boot).catch(fatal)
}

async function boot(): Promise<void> {
  setupWindowChrome(isAppUrl)
  diagnostics = setupDiagnostics({ logDir: dirname(logFile), serverPid: () => server?.pid, origin: () => origin, isAppUrl })
  // Show the window at once: Node, the server and its first page take seconds on
  // Windows, during which a launch with nothing on screen looks ignored.
  openWindow()
  const locale = app.getSystemLocale().replace('-', '_')
  const env = await loginShellEnv(node, locale.includes('_') ? `${locale}.UTF-8` : 'en_US.UTF-8')
  // Bundled Node/npm are fallbacks: user-maintained ones take precedence, but
  // Sillage can install and launch a CLI on an otherwise empty machine.
  const key = pathKey(env)
  env[key] = [env[key], dirname(node)].filter(Boolean).join(delimiter)
  const port = await stablePort(portFile)
  launchSettings = { env, port }
  const settings = launchSettings

  // Before the server: the interface calls these handlers as soon as it loads.
  setupUpdates({
    userData,
    logDir: dirname(logFile),
    isAppUrl,
    stopServer,
    restartServer: () => startAndShow(settings),
    quitForInstall: () => {
      installing = true
      quit()
    },
  })
  await startAndShow(settings, true)
}

/**
 * Start the server and point the windows at it. One start at a time, whoever asks, and
 * none while a server runs. `openIfNone` is for a launch, which must end with a window;
 * a recovery leaves a macOS app without windows as it was.
 */
function startAndShow(settings: LaunchSettings, openIfNone = false): Promise<void> {
  if (starting) return starting
  if (server) return Promise.resolve()
  starting = (async () => {
    if (await startOrAsk(settings)) showInterface(openIfNone)
  })()
    .catch(fatal)
    .finally(() => {
      starting = null
    })
  return starting
}

/**
 * Start the server; when it does not come up, the user decides what happens next.
 * False when the app is quitting instead.
 */
async function startOrAsk(settings: LaunchSettings): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    if (quitting) return false
    try {
      await launch(settings)
      diagnostics?.add('server-ready', { ms: sinceLaunch(), items: attempt })
      return true
    } catch (err) {
      // Closing the startup window stops the server, which must not read as a failure.
      if (quitting) return false
      diagnostics?.add('server-start-failed', { items: attempt })
      await stopServer()
      // Passing causes clear by themselves: try once more before bothering the user.
      if (attempt === 1 && err instanceof ServerStartError && err.reason === 'exit') {
        await delay(RETRY_PAUSE_MS)
        continue
      }
      const choice = askStartFailure(err, true)
      if (choice !== 'retry') {
        await giveUp(choice === 'download')
        return false
      }
      // The saved port may have been taken meanwhile.
      settings.port = await stablePort(portFile)
    }
  }
}

async function launch(settings: LaunchSettings): Promise<void> {
  const started = startServer({
    node,
    runtime: join(resources, 'sillage'),
    dataDir: join(userData, 'data'),
    configFile: join(userData, 'config.toml'),
    logFile,
    port: settings.port,
    env: settings.env,
  })
  server = started
  serving = false
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
  serving = true
  started.onExit((code) => {
    diagnostics?.add('server-exit', { exitCode: code })
    if (quitting || server !== started) return
    server = null
    serving = false
    void stopped(code, settings)
  })
}

/** Milliseconds since this process was created, Electron's own startup included. */
function sinceLaunch(): number {
  return Math.round(Date.now() - (process.getCreationTime() ?? Date.now()))
}

/**
 * Show the interface in every window: the startup page gives way to it, a page of the
 * server that stopped is loaded again.
 */
function showInterface(openIfNone: boolean): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) {
    if (openIfNone) openWindow()
    return
  }
  for (const win of windows) {
    if (isAppUrl(win.webContents.getURL())) win.reload()
    else void win.loadURL(origin)
  }
}

/** Report a server crash during use and offer to restart it. */
async function stopped(code: number | null, settings: LaunchSettings): Promise<void> {
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
  await startAndShow(settings)
}

/** Stop the server without quitting or reporting its exit as a crash. */
async function stopServer(): Promise<void> {
  const running = server
  server = null
  serving = false
  if (!running) return
  const since = Date.now()
  await running.stop()
  diagnostics?.add('server-stop', { ms: Date.now() - since })
}

/**
 * Windows only. Whatever still runs from the installation directory once the server has
 * stopped (a CLI or MCP server under the bundled Node, a terminal) outlives the app. It
 * keeps files the next installer has to replace, and that installer then reports Sillage
 * as running when there is no window left to close.
 */
async function leaveInstallDir(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const log = fileLogger(join(dirname(logFile), 'updater.log'))
  await releaseInstallDir(dirname(app.getPath('exe')), log, LEAVE_TIMEOUT_MS).catch((err: Error) => log.error(err))
}

/** Open on the interface, or on the startup page until the server announces itself. */
function openWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors
  const win = new BrowserWindow({
    ...windowChromeOptions(dark),
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Sillage',
    backgroundColor: dark ? BACKGROUND.dark : BACKGROUND.light,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  if (serving) void win.loadURL(origin)
  else void win.loadFile(join(__dirname, 'splash.html'), { query: { title: text('starting') } })
  win.webContents.on('did-finish-load', () => {
    if (interfaceTimed || !isAppUrl(win.webContents.getURL())) return
    interfaceTimed = true
    diagnostics?.add('interface-ready', { ms: sinceLaunch() })
  })
  return win
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
  // Closing the window a relaunch opened during the stop phase takes that relaunch back.
  reopened = false
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (stopping) reopen()
  else if (BrowserWindow.getAllWindows().length === 0 && origin && !quitting) openWindow()
})

// Quitting stops the server as its service would: clean up active sessions and
// close the database instead of leaving orphaned CLIs. That takes seconds, during which
// the app is still there with nothing on screen.
app.on('before-quit', (event) => {
  if (quitNow) return
  event.preventDefault()
  if (stopping) return
  stopping = true
  quitting = true
  // Quitting from a menu or the Dock leaves the windows up: an interface whose server
  // is going away is worse than none.
  for (const win of BrowserWindow.getAllWindows()) win.hide()
  void stopServer()
    .then(leaveInstallDir)
    .catch(() => undefined)
    .finally(() => {
      stopping = false
      if (reopened) resume()
      else quit()
    })
})

/** Leave for good, past the cleanup above. */
function quit(): void {
  quitNow = true
  quitting = true
  app.quit()
  // A page refusing to unload would keep a windowless app alive, which the next launch
  // or installer finds in its way.
  setTimeout(() => app.exit(0), QUIT_GRACE_MS).unref()
}

/**
 * Launched again while the quit is still stopping the server. This process holds the
 * single-instance lock, so the new one gives up at once and the user would see nothing
 * until trying again later. Take the quit back instead, startup page on screen meanwhile.
 */
function reopen(): void {
  if (reopened) return
  reopened = true
  const hidden = BrowserWindow.getAllWindows()
  openWindow()
  for (const win of hidden) win.destroy()
}

function resume(): void {
  reopened = false
  quitting = false
  // A start the quit interrupted is still settling; before the settings exist, boot is
  // still on its way to its own start.
  void (starting ?? Promise.resolve()).then(() => {
    if (launchSettings && !quitting) void startAndShow(launchSettings, true)
  })
}

function startFailure(err: unknown): string {
  if (!(err instanceof ServerStartError)) return err instanceof Error ? err.message : String(err)
  // A Node that could not be started: the system's own words.
  if (err.reason === 'spawn') return err.detail
  return text(err.reason === 'exit' ? 'serverExited' : 'serverSilent', { detail: err.detail })
}

function askStartFailure(err: unknown, canRetry: boolean): 'retry' | 'download' | 'quit' {
  const choices = canRetry ? (['retry', 'download', 'quit'] as const) : (['download', 'quit'] as const)
  const options = {
    type: 'error' as const,
    title: text('startFailed'),
    message: text('startFailed'),
    detail: `${startFailure(err)}\n\n${text('seeLog', { log: logFile })}\n\n${text('startFailedReinstall')}`,
    buttons: choices.map((choice) => text(choice)),
    defaultId: canRetry ? 0 : choices.length - 1,
    cancelId: choices.length - 1,
  }
  // Attached to the startup window, the dialog cannot hide behind other applications.
  const parent = BrowserWindow.getAllWindows().find((win) => win.isVisible())
  const response = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options)
  return choices[response] ?? 'quit'
}

/**
 * Leave after a start that failed for good. Nothing may stay behind: the user is about
 * to run the installer, which refuses to replace a Sillage it finds running.
 */
async function giveUp(download: boolean): Promise<void> {
  quitting = true
  // A launch during the cleanup below starts over once this process is gone.
  quitNow = true
  for (const win of BrowserWindow.getAllWindows()) win.hide()
  if (download) await shell.openExternal(DOWNLOAD_URL).catch(() => undefined)
  await stopServer().catch(() => undefined)
  await leaveInstallDir()
  app.exit(1)
}

/** A failure outside the server start, which has its own dialog: nothing here to retry. */
function fatal(err: unknown): void {
  if (quitting) return
  void giveUp(askStartFailure(err, false) === 'download')
}
