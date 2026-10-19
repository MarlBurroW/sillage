import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import type { AgentAvailabilityDto, AgentKind } from '@sillage/protocol'
import { CachedProbe } from './cached-probe.js'
import { launchOf } from './launch.js'

const run = promisify(execFile)

/**
 * Résolution et sonde des CLI agents installés sur la machine.
 *
 * Sillage ne transporte plus les binaires : ils viennent du système, donc leur présence
 * et leur version cessent d'être garanties par la release et deviennent une information
 * à afficher. Un CLI absent doit se voir dans l'interface, pas se découvrir à l'échec du
 * premier tour.
 *
 * Deux sources, dans cet ordre : le préfixe où Sillage installe les CLI qu'il gère, puis
 * `process.env.PATH`. Jamais une liste de dossiers écrite en dur : l'unité systemd pose
 * déjà un `PATH` explicite parce que celui d'un service est minimal, et c'est ce même
 * `PATH` que `spawn` consultera. Résoudre ailleurs annoncerait des CLI que le daemon
 * serait incapable de lancer.
 */

/**
 * Ce que `describe` rend : la disponibilité, sans ce qui relève de l'installation.
 * L'état d'une installation en cours appartient à `CliInstaller`, pas au binaire.
 */
export type CliDescription = Omit<AgentAvailabilityDto, 'preferredVersion' | 'install'>

/** Ce qu'on sait d'un CLI, une fois cherché sur le disque. */
export type CliStatus =
  | { readonly found: true; readonly path: string; readonly version: string | null }
  | { readonly found: false; readonly reason: 'not_on_path' | 'not_executable' }

/** Durée de validité d'une sonde. Un CLI installé pendant que le daemon tourne
 *  doit finir par apparaître, sans pour autant relancer un process à chaque écran. */
const TTL_MS = 60_000

/** Fenêtre laissée au CLI pour annoncer sa version. Au-delà, on le dit présent
 *  mais muet : un binaire lent à démarrer reste utilisable. Plus large sous Windows, où
 *  Defender analyse un binaire fraîchement installé à son premier lancement : Grok y a
 *  dépassé les cinq secondes juste après son installation. */
const VERSION_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 5_000

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Chemin absolu du binaire, ou null s'il est introuvable.
 *
 * Un nom nu est cherché dans le `PATH` comme le ferait `spawn`. Un chemin absolu est
 * pris tel quel : la configuration désigne alors une installation précise, et lui
 * substituer une autre trahirait le réglage.
 *
 * Sous Windows, un nom se complète des extensions de `PATHEXT` (`claude.exe`,
 * `codex.cmd`), et npm pose les lanceurs à la racine de son préfixe plutôt que dans
 * `bin/`. `env` et `platform` ne servent qu'aux tests.
 */
export function resolveBinary(
  binary: string,
  managedDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isExecutable,
): string | null {
  const windows = platform === 'win32'
  const paths = windows ? nodePath.win32 : nodePath.posix
  const names = windows ? withExtensions(binary, env) : [binary]
  if (paths.isAbsolute(binary)) return names.find(exists) ?? null

  // Un nom contenant un séparateur est un chemin relatif, que `spawn` résoudrait
  // depuis le répertoire courant du daemon. Ce répertoire n'a rien à voir avec le
  // workspace des conversations, donc le réglage n'aurait pas de sens : on refuse.
  if (binary.includes('/') || (windows && binary.includes('\\'))) return null

  // Ce que Sillage a installé passe avant le PATH du système. L'ordre suit l'intention :
  // un CLI n'atterrit ici que parce que quelqu'un l'a demandé depuis l'interface, alors
  // qu'un CLI du PATH peut n'être là que par accident d'environnement. C'est aussi la
  // seule façon d'honorer « installer une version précise pour Sillage » quand le
  // système en porte déjà une autre.
  const dirs = managedDir ? [windows ? managedDir : paths.join(managedDir, 'bin')] : []
  dirs.push(...(pathValue(env) ?? '').split(paths.delimiter).filter((dir) => dir.length > 0))
  for (const dir of dirs) {
    const found = names.map((name) => paths.join(dir, name)).find(exists)
    if (found) return found
  }
  return null
}

/**
 * Les noms à essayer pour `binary` sous Windows, dans l'ordre de `PATHEXT` : un nom qui
 * porte déjà une extension connue se cherche tel quel.
 */
function withExtensions(binary: string, env: NodeJS.ProcessEnv): string[] {
  const extensions = (pathExt(env) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  if (extensions.some((ext) => binary.toLowerCase().endsWith(ext.toLowerCase()))) return [binary]
  return extensions.map((ext) => `${binary}${ext.toLowerCase()}`)
}

/**
 * `PATH` quelle que soit la casse de sa clé : sous Windows elle s'écrit `Path`, et une
 * copie de `process.env` en objet ordinaire n'est plus insensible à la casse.
 */
function pathValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
}

function pathExt(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATHEXT ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1]
}

/**
 * Version annoncée par `--version`, réduite au numéro.
 *
 * Les CLI habillent leur version différemment (« 2.1.0 (Claude Code) »,
 * « codex-cli 0.5.1 »), et Sillage n'a pas à connaître chaque format : on retient le
 * premier groupe qui ressemble à une version, et à défaut la ligne telle quelle.
 * Null quand le binaire n'a rien répondu d'exploitable : présent vaut mieux
 * qu'introuvable, même sans numéro.
 */
async function probeVersion(binary: string): Promise<string | null> {
  try {
    const launch = launchOf(binary)
    const { stdout } = await run(launch.command, [...launch.args, '--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    })
    const line = stdout.trim().split('\n')[0]?.trim()
    if (!line) return null
    return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(line)?.[0] ?? line
  } catch {
    return null
  }
}

async function probe(binary: string, managedDir: string): Promise<CliStatus> {
  const path = resolveBinary(binary, managedDir)
  if (!path) {
    // Distinguer les deux cas vaut la peine : un binaire présent mais sans bit
    // d'exécution se répare d'un `chmod`, une absence demande une installation.
    return { found: false, reason: nodePath.isAbsolute(binary) ? 'not_executable' : 'not_on_path' }
  }
  return { found: true, path, version: await probeVersion(path) }
}

/**
 * Le CLI d'un agent : où il est, quelle version, et s'il est utilisable.
 *
 * Une instance par adaptateur, parce que le cache et la lecture unique en vol
 * appartiennent au CLI et non à l'appelant. Elle porte aussi la mise en forme pour
 * l'API : les deux adaptateurs la recomposeraient à l'identique.
 */
export class CliBinary {
  private readonly cache: CachedProbe<{ status: CliStatus }>

  constructor(
    private readonly kind: AgentKind,
    readonly configured: string,
    private readonly enabled: boolean,
    /** Préfixe npm des CLI que Sillage installe lui-même. */
    readonly managedDir: string,
  ) {
    this.cache = new CachedProbe(TTL_MS, async () => ({
      status: await probe(configured, managedDir),
    }))
  }

  async status(force = false): Promise<CliStatus> {
    return (await this.cache.read(force)).status
  }

  /**
   * Oublie la dernière sonde. À appeler quand on sait que le disque a changé : une
   * installation qui vient d'aboutir ne doit pas rester « absente » jusqu'au bout du TTL,
   * sans quoi l'écran re-propose d'installer ce qui vient de l'être.
   */
  invalidate(): void {
    this.cache.invalidate()
  }

  /**
   * État tel que l'écran le lit.
   *
   * Un agent désactivé en configuration n'est pas sondé : lancer un process pour un CLI
   * que l'utilisateur a explicitement écarté serait du travail pour rien, et « absent »
   * répondrait à côté de la raison réelle.
   */
  async describe(force = false): Promise<CliDescription> {
    const base = { agent: this.kind, binary: this.configured, enabled: this.enabled }
    if (!this.enabled) {
      return {
        ...base,
        installed: false,
        managed: false,
        path: null,
        version: null,
        reason: 'disabled',
      }
    }

    const status = await this.status(force)
    if (!status.found) {
      return {
        ...base,
        installed: false,
        managed: false,
        path: null,
        version: null,
        reason: status.reason,
      }
    }
    return {
      ...base,
      installed: true,
      // D'où vient le binaire, pour que l'écran puisse le dire : entre un CLI du système
      // et un que Sillage a posé, l'utilisateur n'a aucun moyen de deviner lequel tourne.
      managed: status.path.startsWith(this.managedDir),
      path: status.path,
      version: status.version,
      reason: null,
    }
  }

  /**
   * Chemin absolu à lancer, ou le nom configuré si la résolution échoue.
   *
   * Le repli n'est pas une politesse : laisser `spawn` échouer avec son propre `ENOENT`
   * sur le nom demandé donne un message plus juste qu'une erreur inventée ici, et évite
   * qu'une résolution ratée à froid empêche un lancement qui aurait marché.
   */
  async executable(): Promise<string> {
    const status = await this.status()
    return status.found ? status.path : this.configured
  }
}
