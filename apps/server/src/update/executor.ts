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

/**
 * Applique une mise à jour sur le layout de l'installeur :
 *
 *   $SILLAGE_INSTALL_DIR/
 *   ├── releases/vX.Y.Z/     un arbre autonome par version (node_modules inclus)
 *   └── current -> releases/vX.Y.Z
 *
 * Rien n'est jamais modifié dans une release existante : on télécharge, on
 * extrait dans un dossier de transit, puis on bascule le lien `current` d'un
 * `rename` atomique. Tant que la bascule n'a pas eu lieu, un échec laisse
 * l'installation intacte. Le redémarrage est délégué à systemd.
 */
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

  /**
   * Valide et démarre la mise à jour, sans l'attendre : la route répond 202 et
   * le client suit la progression en sondant getStatus().
   */
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
      // L'archive a un dossier racine `sillage/` : on l'aplatit dans le dossier
      // de transit, renommé en dossier de release seulement une fois complet.
      await execFileAsync('tar', ['-xzf', archive, '--strip-components=1', '-C', stagingDir])
      await rm(releaseDir, { recursive: true, force: true })
      await rename(stagingDir, releaseDir)
      await rm(archive, { force: true })
      this.append('Extraction terminée.')

      this.status = { ...this.status, phase: 'switching' }
      const currentTmp = join(root, 'current.tmp')
      await rm(currentTmp, { force: true })
      await symlink(join('releases', `v${target}`), currentTmp)
      // rename() écrase `current` atomiquement ; un unlink+symlink laisserait
      // une fenêtre sans lien si le process meurt entre les deux.
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

  /** Garde la version courante et les deux précédentes, supprime le reste. */
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

  /**
   * `systemctl --user restart` tue ce process en plein appel : le fils doit
   * être détaché pour survivre. Si systemctl n'est pas joignable (pas de bus
   * utilisateur), on sort en erreur pour que `Restart=` de l'unité relance le
   * process, qui suivra alors le lien `current` déjà basculé.
   */
  private scheduleRestart(): void {
    setTimeout(() => {
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
