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

/** The downloader used internally by electron-updater, missing from its public types. */
interface Downloader {
  download(url: URL, destination: string, options: unknown): Promise<string>
}

/**
 * Squirrel.Mac requires the new app to satisfy the installed app's designated
 * signature requirement. Our ad hoc signature identifies only its own binary,
 * so no later release can satisfy it until we have a Developer ID certificate.
 * Keep electron-updater discovery, downloading and SHA-512 validation, then
 * extract and check bundle identity, version and signature ourselves. A detached
 * script replaces the bundle after exit and records its result for next launch.
 */
export class MacBundleUpdater extends BaseUpdater {
  private staged: string | null = null

  constructor(private readonly resultFile: string) {
    super()
  }

  protected override doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { provider, info } = options.updateInfoAndProvider
    const zips = provider.resolveFiles(info).filter((file) => file.url.pathname.endsWith('.zip'))
    // Select the architecture-specific zip if more than one becomes available.
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

  /** Only announce readiness once extraction and verification succeed. */
  protected override dispatchUpdateDownloaded(event: UpdateDownloadedEvent): void {
    this.stage(event.downloadedFile, event.version).then(
      (bundle) => {
        this.staged = bundle
        super.dispatchUpdateDownloaded(event)
      },
      (err: unknown) => {
        // Discard the invalid cached zip so the next check can download it again.
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
    // ditto preserves quarantine attributes, which could prevent the replacement from launching.
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

/** Locate the running .app bundle from its executable. */
export function runningBundle(): string {
  return resolve(app.getPath('exe'), '..', '..', '..')
}

/**
 * Disk images and Gatekeeper-translocated copies cannot replace themselves.
 * Check both the bundle and its parent before offering an update.
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
 * Wait for the app and server to exit before replacement. Restore the old bundle
 * if installation fails; retain the backup if restoration fails too.
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
  if [ -e "$old" ]; then
    echo "A previous application backup already exists at $old." > "$result"
    return
  fi
  if ! error=$(mv "$app" "$old" 2>&1); then
    echo "$error" > "$result"
    return
  fi
  if ! error=$(mv "$staged" "$app" 2>&1); then
    if ! mv "$old" "$app"; then
      echo "$error; restore failed, previous application retained at $old." > "$result"
      return
    fi
    echo "$error" > "$result"
    return
  fi
  echo ok > "$result"
  rm -rf "$old"
}
swap
if [ "$relaunch" = 1 ]; then
  open "$app"
fi
`
