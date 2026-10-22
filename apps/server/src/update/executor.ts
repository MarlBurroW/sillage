import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { UpdateStatus } from '@sillage/protocol'
import type { FastifyBaseLogger } from 'fastify'
import { detectChannel, installDir } from './channel.js'
import { CURRENT_VERSION, compareVersions } from './version.js'
import type { ReleaseChecker } from './release-checker.js'

const execFileAsync = promisify(execFile)

/** Updates installer layouts: `$SILLAGE_INSTALL_DIR/` contains independent `releases/vX.Y.Z/` trees including node_modules, with `current -> releases/vX.Y.Z`. Never modify existing releases: download and extract into staging, then atomically rename the `current` link. Failures before activation leave installations intact. Delegate restart to systemd or macOS launchd. */
export class UpdateExecutor {
  private status: UpdateStatus = {
    phase: 'idle',
    targetVersion: null,
    startedAt: null,
    log: [],
    error: null,
  }

  constructor(
    private readonly checker: ReleaseChecker,
    private readonly logger: FastifyBaseLogger,
  ) {}

  getStatus(): UpdateStatus {
    return this.status
  }

  isRunning(): boolean {
    return !['idle', 'failed'].includes(this.status.phase)
  }

  /** Validates and starts updates without awaiting: routes return 202 and clients poll getStatus() for progress. */
  start(targetTag: string): void {
    if (detectChannel() !== 'installer') {
      throw new UpdateError('unsupported_channel', 'This installation does not support the built-in update.')
    }
    if (this.isRunning()) {
      throw new UpdateError('update_running', 'An update is already in progress.')
    }
    const target = targetTag.replace(/^v/, '')
    if (compareVersions(target, CURRENT_VERSION) <= 0) {
      throw new UpdateError('not_newer', `Version ${target} is not newer than ${CURRENT_VERSION}.`)
    }
    const assetUrl = this.checker.findAsset(target)
    if (!assetUrl) {
      throw new UpdateError('asset_not_found', `No archive for this platform in release v${target}.`)
    }

    this.status = {
      phase: 'downloading',
      targetVersion: target,
      startedAt: new Date().toISOString(),
      log: [],
      error: null,
    }
    void this.run(target, assetUrl).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error({ err }, 'mise à jour échouée')
      this.append(`Échec : ${message}`)
      this.status = { ...this.status, phase: 'failed', error: message }
    })
  }

  private async run(target: string, assetUrl: string): Promise<void> {
    const root = installDir()
    const tmpDir = join(root, 'tmp')
    const stagingDir = join(root, 'releases', `.staging-v${target}`)
    const releaseDir = join(root, 'releases', `v${target}`)

    try {
      await mkdir(tmpDir, { recursive: true })
      const archive = join(tmpDir, `sillage-v${target}.tar.gz`)

      this.append(`Téléchargement de la version ${target}…`)
      const res = await fetch(assetUrl, { redirect: 'follow' })
      if (!res.ok || !res.body) {
        throw new Error(`téléchargement refusé (HTTP ${res.status})`)
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(archive))
      this.append('Archive téléchargée.')

      this.status = { ...this.status, phase: 'extracting' }
      this.append('Extraction…')
      await rm(stagingDir, { recursive: true, force: true })
      await mkdir(stagingDir, { recursive: true })
      // Flatten archive root `sillage/` into staging,
      // renaming to the release directory only when complete.
      await execFileAsync('tar', ['-xzf', archive, '--strip-components=1', '-C', stagingDir])
      await this.ensureNativeModules(stagingDir)
      await rm(releaseDir, { recursive: true, force: true })
      await rename(stagingDir, releaseDir)
      await rm(archive, { force: true })
      this.append('Extraction terminée.')

      this.status = { ...this.status, phase: 'switching' }
      const currentTmp = join(root, 'current.tmp')
      await rm(currentTmp, { force: true })
      await symlink(join('releases', `v${target}`), currentTmp)
      // rename() replaces `current` atomically; unlink+symlink would leave missing links
      // if processes die between steps.
      await rename(currentTmp, join(root, 'current'))
      this.append(`Version ${target} activée.`)

      await this.pruneOldReleases(root, target)

      this.status = { ...this.status, phase: 'restarting' }
      this.append('Redémarrage du service…')
      this.scheduleRestart()
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }

  /** Loads the new version's native module and rebuilds if needed before activation. All native modules use N-API rather than specific Node ABIs and should load everywhere, but truncated archives or unsupported prebuild platforms can still fail. Activating broken versions would create restart loops and remove the interface needed for rollback. Failure here leaves `current` on the working release. */
  private async ensureNativeModules(dir: string): Promise<void> {
    const loads = () =>
      // Execute a query, not just require: Node lacking the module's N-API version
      // can load it successfully but crashes on the first call.
      execFileAsync(process.execPath, ['-e', 'require("better-sqlite3")(":memory:").prepare("select 1").get()'], { cwd: dir })

    try {
      await loads()
      return
    } catch (err) {
      this.append(
        `Module natif illisible sous ${process.version}, recompilation… (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
      )
    }

    try {
      // Sources accompany archives, so rebuilding downloads nothing
      // but requires local build tools.
      await execFileAsync('npm', ['rebuild', 'better-sqlite3'], { cwd: dir })
      await loads()
    } catch (err) {
      throw new Error(
        `better-sqlite3 ne peut pas être recompilé pour ${process.version} : ${err instanceof Error ? err.message.split('\n')[0] : String(err)}. ` +
          `Installez de quoi compiler (${process.platform === 'darwin' ? 'xcode-select --install' : 'build-essential, python3'}). La version en place est conservée.`,
      )
    }
    this.append('Module natif recompilé.')
  }

  /** Retains current and two previous versions, deleting others. */
  private async pruneOldReleases(root: string, target: string): Promise<void> {
    const entries = await readdir(join(root, 'releases'))
    const versions = entries
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => compareVersions(b, a))
    for (const name of versions.slice(3)) {
      if (name === `v${target}`) continue
      await rm(join(root, 'releases', name), { recursive: true, force: true })
      this.append(`Ancienne version ${name} supprimée.`)
    }
  }

  /** `systemctl --user restart` kills this process mid-call, so detach children to survive. If systemctl is unreachable without user buses, exit with failure so unit `Restart=` relaunches through the activated `current` link. launchd `KeepAlive` restarts on any exit; self-SIGTERM triggers graceful main.ts cleanup without knowing agent labels. */
  private scheduleRestart(): void {
    setTimeout(() => {
      if (process.platform === 'darwin') {
        process.kill(process.pid, 'SIGTERM')
        return
      }
      try {
        const child = spawn('systemctl', ['--user', 'restart', 'sillage.service'], {
          detached: true,
          stdio: 'ignore',
        })
        child.on('error', () => process.exit(1))
        child.unref()
      } catch {
        process.exit(1)
      }
    }, 500)
  }

  private append(line: string): void {
    this.logger.info({ update: true }, line)
    this.status = { ...this.status, log: [...this.status.log, line] }
  }
}

export class UpdateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
