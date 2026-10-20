import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { AppImageUpdater, DebUpdater, NsisUpdater, type BaseUpdater, type Logger } from 'electron-updater'
import type { DesktopUpdateState, DesktopUpdateUnsupportedReason } from '@sillage/protocol'
import { UPDATE_CHANNELS } from './ipc'
import { MacBundleUpdater, bundleIsReplaceable } from './mac-updater'

/** Laisser le serveur et la fenêtre démarrer avant d'aller voir GitHub. */
const FIRST_CHECK_DELAY_MS = 10_000
/** Une app de bureau reste ouverte des jours : elle revérifie d'elle-même. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const LOG_ROTATE_BYTES = 1024 * 1024

export interface UpdateOptions {
  userData: string
  logDir: string
  /** Seule l'interface de l'app pilote la mise à jour. */
  isAppUrl(url: string): boolean
  stopServer(): Promise<void>
  /** Relance le serveur quand l'installation n'a pas pu partir après son arrêt. */
  restartServer(): Promise<void>
}

/**
 * La mise à jour de l'app de bureau, par electron-updater et les releases GitHub
 * (`publish` dans electron-builder.yml, qui écrit les latest*.yml publiés avec les paquets).
 *
 * L'app cherche au lancement puis toutes les quatre heures, télécharge ce qu'elle trouve,
 * et l'installe en se fermant ; l'écran « À propos » propose aussi de redémarrer tout de
 * suite. Chaque format a son updater : l'installeur NSIS sous Windows, l'AppImage ou le
 * paquet .deb sous Linux, et sous macOS le nôtre (`mac-updater.ts`), Squirrel.Mac refusant
 * une app signée ad hoc. Le journal va dans `updater.log`, à côté de celui du serveur.
 *
 * SILLAGE_DESKTOP_UPDATE_FEED remplace les releases par un dossier servi en HTTP, celui
 * du contrôle de mise à jour (scripts/desktop-update-check.mjs).
 */
export function setupUpdates(options: UpdateOptions): void {
  const resultFile = join(options.userData, 'update-result')
  const created = createUpdater(resultFile)
  const updater = typeof created === 'string' ? null : created
  let state: DesktopUpdateState = updater
    ? (previousInstall(resultFile) ?? { status: 'idle', checkedAt: null })
    : { status: 'unsupported', reason: created as DesktopUpdateUnsupportedReason }

  const publish = (next: DesktopUpdateState) => {
    state = next
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(UPDATE_CHANNELS.changed, state)
  }

  const check = async () => {
    // Une version prête s'installera à la fermeture ; une plus récente sera trouvée au
    // lancement suivant, sans retélécharger ni réextraire celle-ci toutes les quatre heures.
    if (!updater || state.status === 'downloading' || state.status === 'ready' || state.status === 'installing') return
    // L'échec arrive aussi par l'événement `error`, qui le publie.
    await updater.checkForUpdates().catch(() => undefined)
  }

  const install = async () => {
    if (!updater || state.status !== 'ready') return
    publish({ status: 'installing', version: state.version })
    const appImage = updater instanceof AppImageUpdater ? process.env.APPIMAGE : undefined
    // L'installeur Windows tue, une seconde après son lancement, tout process lancé du
    // dossier de l'app, serveur compris : celui-ci doit avoir rangé ses sessions avant.
    if (process.platform === 'win32') await options.stopServer()
    // Relancée par l'updater, la nouvelle AppImage trouverait l'ancienne encore là, et son
    // verrou d'instance unique : Electron, lui, attend que celle-ci soit sortie.
    const installed = updater.install(true, appImage === undefined)
    if (!installed) {
      if (process.platform === 'win32') await options.restartServer()
      return
    }
    if (appImage) app.relaunch({ execPath: appImage, args: process.argv.slice(1) })
    app.quit()
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

  if (!updater) return
  updater.logger = fileLogger(join(options.logDir, 'updater.log'))
  // Le .deb s'installe par dpkg, donc avec le mot de passe de l'administrateur : on ne le
  // réclame pas à la fermeture, seulement quand l'utilisateur demande la mise à jour.
  updater.autoInstallOnAppQuit = !(updater instanceof DebUpdater)
  const feed = process.env.SILLAGE_DESKTOP_UPDATE_FEED
  if (feed) {
    updater.setFeedURL({ provider: 'generic', url: feed })
    // Les blockmaps se retrouvent par le numéro de version dans l'URL, absent d'un dossier
    // de test : le téléchargement différentiel n'y a rien à comparer.
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
    // La release est publiée avant que ses paquets de bureau n'y soient ajoutés : pendant
    // ce temps, il n'y a simplement rien à installer.
    if (err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
      publish({ status: 'idle', checkedAt: new Date().toISOString() })
      return
    }
    const version = state.status === 'downloading' || state.status === 'installing' ? state.version : null
    publish({ status: 'error', message: err.message, version, macPermission: isMacPermission(err.message) })
  })

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS)
  setInterval(() => void check(), CHECK_INTERVAL_MS)
}

function createUpdater(resultFile: string): BaseUpdater | DesktopUpdateUnsupportedReason {
  // Lancée depuis le dépôt, ou build de CI (0.0.0-dev) : rien de publié à quoi se comparer.
  if (!app.isPackaged || !/^\d+\.\d+\.\d+$/.test(app.getVersion())) return 'development'
  if (process.platform === 'win32') return new NsisUpdater()
  if (process.platform === 'darwin') return bundleIsReplaceable() ? new MacBundleUpdater(resultFile) : 'location'
  // L'AppImage d'abord : la cible .deb écrit `package-type` dans le dossier qu'elle partage
  // avec l'AppImage, qui peut donc l'embarquer aussi. Le dossier décompressé (`*-unpacked`),
  // qui le porte également, n'est installé nulle part.
  if (process.env.APPIMAGE) return new AppImageUpdater()
  if (packageType() === 'deb' && !/-unpacked[\\/]/.test(app.getPath('exe'))) return new DebUpdater()
  return 'package'
}

function packageType(): string | null {
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Le verdict du remplacement de l'app sous macOS, que le script d'installation a laissé
 * en se terminant après la fermeture de l'app. Lu une fois : un échec s'affiche au
 * lancement qui suit, puis disparaît à la recherche suivante.
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
    // Pas encore de journal.
  }
  const write = (level: string) => (message?: unknown) => {
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message)
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`)
    } catch {
      // Un journal qu'on ne peut pas écrire ne doit pas arrêter la mise à jour.
    }
  }
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') }
}
