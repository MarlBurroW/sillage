import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { BaseUpdater, type UpdateDownloadedEvent } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import type { InstallOptions } from 'electron-updater/out/BaseUpdater'

const execFileAsync = promisify(execFile)

/** Ce qu'electron-updater ne déclare pas mais que ses propres updaters utilisent. */
interface Downloader {
  download(url: URL, destination: string, options: unknown): Promise<string>
}

/**
 * La mise à jour sous macOS, sans Squirrel.Mac.
 *
 * Le MacUpdater d'electron-updater confie la nouvelle version à Squirrel.Mac, qui exige
 * que sa signature satisfasse l'exigence désignée de l'app en place. Une signature ad hoc,
 * la nôtre tant qu'il n'y a pas de certificat Developer ID, ne désigne que l'empreinte de
 * son propre binaire : aucune version suivante ne la satisfait, et Squirrel les refuse
 * toutes.
 *
 * Celui-ci garde d'electron-updater la recherche, le téléchargement et le contrôle du zip
 * (SHA-512 de latest-mac.yml). Il extrait lui-même l'app à côté et vérifie son identifiant,
 * sa version et sa signature ; puis, Sillage fermé, un script détaché met la nouvelle app
 * à la place de l'ancienne et la relance. Le script laisse son verdict dans `resultFile`,
 * que l'app relit au lancement suivant : c'est là qu'un échec se voit.
 */
export class MacBundleUpdater extends BaseUpdater {
  private staged: string | null = null

  constructor(private readonly resultFile: string) {
    super()
  }

  protected override doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { provider, info } = options.updateInfoAndProvider
    const zips = provider.resolveFiles(info).filter((file) => file.url.pathname.endsWith('.zip'))
    // Un zip par architecture, si un jour il y en a deux : `Sillage-mac-arm64.zip`.
    const fileInfo = zips.find((file) => file.url.pathname.endsWith(`-${process.arch}.zip`)) ?? (zips.length === 1 ? zips[0] : undefined)
    if (!fileInfo) throw new Error(`The update to ${info.version} has no archive for macOS ${process.arch}.`)
    const http = (this as unknown as { httpExecutor: Downloader }).httpExecutor
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo,
      downloadUpdateOptions: options,
      task: (destination, downloadOptions) => http.download(fileInfo.url, destination, downloadOptions),
    })
  }

  /** L'app n'est annoncée prête qu'une fois extraite et vérifiée. */
  protected override dispatchUpdateDownloaded(event: UpdateDownloadedEvent): void {
    this.stage(event.downloadedFile, event.version).then(
      (bundle) => {
        this.staged = bundle
        super.dispatchUpdateDownloaded(event)
      },
      (err: unknown) => {
        // Le zip en cache resservirait tel quel à la recherche suivante : on le jette.
        void this.downloadedUpdateHelper?.clear()
        this.dispatchError(err instanceof Error ? err : new Error(String(err)))
      },
    )
  }

  private async stage(zip: string, version: string): Promise<string> {
    const cacheDir = this.downloadedUpdateHelper?.cacheDir
    if (!cacheDir) throw new Error('The update cache is not ready.')
    const dir = join(cacheDir, 'staged')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await execFileAsync('ditto', ['-x', '-k', zip, dir])
    const name = readdirSync(dir).find((entry) => entry.endsWith('.app'))
    if (!name) throw new Error('The update archive holds no app.')
    const bundle = join(dir, name)
    // Téléchargé par l'app, le zip ne porte pas de quarantaine ; s'il en portait une, ditto
    // la recopierait, et Gatekeeper bloquerait la relance.
    await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', bundle]).catch(() => undefined)
    const [id, runningId, staged] = await Promise.all([
      plistValue(bundle, 'CFBundleIdentifier'),
      plistValue(runningBundle(), 'CFBundleIdentifier'),
      plistValue(bundle, 'CFBundleShortVersionString'),
    ])
    if (id !== runningId) throw new Error(`The update is another app (${id}).`)
    if (staged !== version) throw new Error(`The update archive holds version ${staged}, not ${version}.`)
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', bundle])
    return bundle
  }

  protected override doInstall(options: InstallOptions): boolean {
    const staged = this.staged
    if (!staged || !existsSync(staged)) throw new Error('The update is not ready to install yet.')
    const bundle = runningBundle()
    if (!bundleIsReplaceable(bundle)) throw new Error(`Sillage cannot replace itself in ${dirname(bundle)}.`)
    const script = join(dirname(dirname(staged)), 'install.sh')
    writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 })
    const child = spawn(
      '/bin/sh',
      [script, String(process.pid), bundle, staged, options.isForceRunAfter ? '1' : '0', this.resultFile],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
    return true
  }
}

/** Le paquet .app en cours d'exécution, d'après le chemin de son exécutable. */
export function runningBundle(): string {
  return resolve(app.getPath('exe'), '..', '..', '..')
}

/**
 * Vrai si l'app peut se remplacer là où elle est. Elle ne le peut pas lancée depuis son
 * image disque, ni dans la copie en lecture seule où Gatekeeper isole une app ouverte
 * hors du dossier Applications sans y avoir été déplacée.
 */
export function bundleIsReplaceable(bundle = runningBundle()): boolean {
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/')) return false
  try {
    accessSync(dirname(bundle), constants.W_OK)
    accessSync(bundle, constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function plistValue(bundle: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(bundle, 'Contents', 'Info.plist')])
  return stdout.trim()
}

/**
 * Attend que Sillage soit fermé, serveur compris, puis échange les deux apps. Deux
 * renommages dans le même dossier : l'app n'est absente que l'instant qui les sépare, et
 * un échec du second remet l'ancienne en place. La relance, demandée, rouvre l'app qui est
 * en place, nouvelle ou ancienne ; l'ancienne, quelques centaines de Mo, ne s'efface
 * qu'ensuite.
 */
const INSTALL_SCRIPT = `#!/bin/sh
pid=$1 app=$2 staged=$3 relaunch=$4 result=$5
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 1200 ]; then
    echo "Sillage did not quit within two minutes." > "$result"
    exit 1
  fi
  sleep 0.1
done
swap() {
  old="$app.previous"
  rm -rf "$old"
  if ! error=$(mv "$app" "$old" 2>&1); then
    echo "$error" > "$result"
    return
  fi
  if ! error=$(mv "$staged" "$app" 2>&1); then
    mv "$old" "$app"
    echo "$error" > "$result"
    return
  fi
  echo ok > "$result"
}
swap
if [ "$relaunch" = 1 ]; then
  open "$app"
fi
rm -rf "$app.previous"
`
