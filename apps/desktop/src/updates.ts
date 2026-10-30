import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { AppImageUpdater, DebUpdater, NsisUpdater, type BaseUpdater, type Logger } from 'electron-updater'
import type { DesktopUpdateState, DesktopUpdateUnsupportedReason } from '@sillage/protocol'
import { releaseInstallDir } from './install-dir'
import { UPDATE_CHANNELS } from './ipc'
import { MacBundleUpdater, bundleIsReplaceable } from './mac-updater'
import { text } from './texts'

/** Let the server and window start before contacting GitHub. */
const FIRST_CHECK_DELAY_MS = 10_000
/** Desktop apps can stay open for days, so check again periodically. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const LOG_ROTATE_BYTES = 1024 * 1024
/** Leftover CLIs die on taskkill; this mostly covers PowerShell listing them. */
const RELEASE_TIMEOUT_MS = 15_000
/** After quitting for an update, exit even if a page refuses to unload. */
const QUIT_GRACE_MS = 5_000

export interface UpdateOptions {
  userData: string
  logDir: string
  /** Only the application UI may control updates. */
  isAppUrl(url: string): boolean
  stopServer(): Promise<void>
  /** Restart the server if installation fails after it has stopped. */
  restartServer(): Promise<void>
}

export interface DesktopUpdates {
  /**
   * Called once the server has stopped on quit: an update installing on quit runs the same
   * installer, which needs the installation directory free of leftover processes.
   */
  prepareQuit(): Promise<void>
}

/**
 * Update the entire desktop app from GitHub releases (electron-builder writes the
 * app-update.yml and latest*.yml metadata). Check on launch and every four hours,
 * download in the background, and install on quit or from About.
 * Windows uses NSIS; Linux uses AppImage or .deb. macOS uses our bundle updater
 * because Squirrel.Mac rejects ad hoc signatures. Logs go beside the server log.
 * SILLAGE_DESKTOP_UPDATE_FEED overrides GitHub for the end-to-end check.
 */
export function setupUpdates(options: UpdateOptions): DesktopUpdates {
  const resultFile = join(options.userData, 'update-result')
  const created = createUpdater(resultFile)
  const updater = typeof created === 'string' ? null : created
  const log = fileLogger(join(options.logDir, 'updater.log'))
  let state: DesktopUpdateState = updater
    ? (previousInstall(resultFile) ?? { status: 'idle', checkedAt: null })
    : { status: 'unsupported', reason: created as DesktopUpdateUnsupportedReason }

  const publish = (next: DesktopUpdateState) => {
    state = next
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(UPDATE_CHANNELS.changed, state)
  }

  const check = async () => {
    // A ready update installs on quit; discover newer versions at the next launch.
    if (!updater || state.status === 'downloading' || state.status === 'ready' || state.status === 'installing') return
    // The error event publishes failures.
    await updater.checkForUpdates().catch(() => undefined)
  }

  const installDir = () => dirname(app.getPath('exe'))

  const install = async () => {
    if (!updater || state.status !== 'ready') return
    const { version } = state
    publish({ status: 'installing', version })
    const appImage = updater instanceof AppImageUpdater ? process.env.APPIMAGE : undefined
    if (process.platform === 'win32') {
      // NSIS kills processes in the install directory shortly after starting; stop the server first.
      await options.stopServer()
      // Then nothing may still run from the directory: NSIS would ask the user to close it,
      // and cancelling there leaves a half-replaced installation. Better to report it here.
      const survivors = await releaseInstallDir(installDir(), log, RELEASE_TIMEOUT_MS).catch((err: Error) => {
        log.error(err)
        return []
      })
      if (survivors.length > 0) {
        const processes = survivors.map((found) => `${found.name} (${found.pid})`).join(', ')
        publish({ status: 'error', message: text('stillRunning', { processes }), version, macPermission: false })
        await options.restartServer()
        return
      }
    }
    // Windows installs visibly: the silent installer leaves the user with a closed app, a
    // Start menu shortcut to a removed executable and no sign that anything is happening
    // until the app relaunches on its own. When updating, NSIS never prompts, only shows progress.
    const silent = process.platform !== 'win32'
    // Electron waits for this instance to exit before relaunching, avoiding the single-instance lock.
    const installed = updater.install(silent, appImage === undefined)
    if (!installed) {
      if (process.platform === 'win32') await options.restartServer()
      return
    }
    if (appImage) app.relaunch({ execPath: appImage, args: process.argv.slice(1) })
    app.quit()
    // The installer waits for this process, then asks the user to close it: a page refusing
    // to unload must not keep it alive.
    setTimeout(() => app.exit(0), QUIT_GRACE_MS).unref()
  }

  const prepareQuit = async () => {
    if (!updater || process.platform !== 'win32' || state.status !== 'ready' || !updater.autoInstallOnAppQuit) return
    const survivors = await releaseInstallDir(installDir(), log, RELEASE_TIMEOUT_MS).catch((err: Error) => {
      log.error(err)
      return []
    })
    // The silent installer then gives up on its own; the update is offered again at next launch.
    if (survivors.length > 0) log.warn('installation on quit will be refused by the installer')
  }

  const guarded =
    <T>(handler: () => T) =>
    (event: IpcMainInvokeEvent): T => {
      if (!options.isAppUrl(event.senderFrame?.url ?? '')) throw new Error('refused')
      return handler()
    }
  ipcMain.handle(UPDATE_CHANNELS.state, guarded(() => state))
  ipcMain.handle(UPDATE_CHANNELS.check, guarded(check))
  ipcMain.handle(UPDATE_CHANNELS.install, guarded(install))

  if (!updater) return { prepareQuit }
  updater.logger = log
  // The .deb requires administrator permission; ask only on explicit installation, never on quit.
  updater.autoInstallOnAppQuit = !(updater instanceof DebUpdater)
  const feed = process.env.SILLAGE_DESKTOP_UPDATE_FEED
  if (feed) {
    updater.setFeedURL({ provider: 'generic', url: feed })
    // Test feeds have no versioned URLs for differential blockmap downloads.
    updater.disableDifferentialDownload = true
  }

  updater.on('checking-for-update', () => publish({ status: 'checking' }))
  updater.on('update-not-available', () => publish({ status: 'idle', checkedAt: new Date().toISOString() }))
  updater.on('update-available', (info) => publish({ status: 'downloading', version: info.version, percent: 0 }))
  updater.on('download-progress', (progress) => {
    const percent = Math.floor(progress.percent)
    if (state.status === 'downloading' && percent !== state.percent) publish({ ...state, percent })
  })
  updater.on('update-downloaded', (info) =>
    publish({ status: 'ready', version: info.version, installOnQuit: updater.autoInstallOnAppQuit }),
  )
  updater.on('error', (err: Error & { code?: string }) => {
    if (state.status === 'ready') return
    // Release packages may still be uploading when the release first appears.
    if (err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
      publish({ status: 'idle', checkedAt: new Date().toISOString() })
      return
    }
    const version = state.status === 'downloading' || state.status === 'installing' ? state.version : null
    publish({ status: 'error', message: err.message, version, macPermission: isMacPermission(err.message) })
  })

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS)
  setInterval(() => void check(), CHECK_INTERVAL_MS)
  return { prepareQuit }
}

function createUpdater(resultFile: string): BaseUpdater | DesktopUpdateUnsupportedReason {
  // Development builds have no published release to compare against.
  if (!app.isPackaged || !/^\d+\.\d+\.\d+$/.test(app.getVersion())) return 'development'
  if (process.platform === 'win32') {
    const updater = new NsisUpdater()
    // We publish the full installer, not a web installer fetching additional packages.
    updater.disableWebInstaller = true
    return updater
  }
  if (process.platform === 'darwin') return bundleIsReplaceable() ? new MacBundleUpdater(resultFile) : 'location'
  // Check APPIMAGE first: the .deb target writes package-type into the shared package
  // folder, so AppImages can contain it too. An unpacked directory is not installed.
  if (process.env.APPIMAGE) return new AppImageFileUpdater()
  if (packageType() === 'deb' && !/-unpacked[\\/]/.test(app.getPath('exe'))) return new DebUpdater()
  return 'package'
}

/**
 * Replace the AppImage without running it for a license prompt we do not use.
 * With APPIMAGE_EXTRACT_AND_RUN, that extra launch can overflow execFileSync output
 * and report failure after the file was already replaced.
 */
class AppImageFileUpdater extends AppImageUpdater {
  protected override doInstall(): boolean {
    const appImage = process.env.APPIMAGE
    const update = this.installerPath
    if (!appImage || !isAbsolute(appImage) || !update) throw new Error('No AppImage to replace.')
    // Stage beside the target first, then rename atomically, including across filesystems.
    const staged = `${appImage}.update`
    execFileSync('mv', ['-f', update, staged])
    chmodSync(staged, 0o755)
    renameSync(staged, appImage)
    return true
  }
}

function packageType(): string | null {
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Read the macOS installer result left after the old app exited. Display failures
 * on next launch; a new check clears them.
 */
function previousInstall(file: string): DesktopUpdateState | null {
  let result: string
  try {
    result = readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
  rmSync(file, { force: true })
  if (result === 'ok') return null
  return { status: 'error', message: result, version: null, macPermission: isMacPermission(result) }
}

function isMacPermission(message: string): boolean {
  return process.platform === 'darwin' && /operation not permitted/i.test(message)
}

function fileLogger(file: string): Logger {
  mkdirSync(dirname(file), { recursive: true })
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // No log yet.
  }
  const write = (level: string) => (message?: unknown) => {
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message)
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`)
    } catch {
      // Logging failures must not interrupt updates.
    }
  }
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') }
}
