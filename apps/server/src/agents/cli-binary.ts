import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { CachedProbe } from './cached-probe.js'

const run = promisify(execFile)

/**
 * Résolution et sonde des CLI agents installés sur la machine.
 *
 * Sillage ne transporte plus les binaires : ils viennent du système, donc leur présence
 * et leur version cessent d'être garanties par la release et deviennent une information
 * à afficher. Un CLI absent doit se voir dans l'interface, pas se découvrir à l'échec du
 * premier tour.
 *
 * Tout passe par `process.env.PATH`, jamais par une liste de dossiers écrite ici :
 * l'unité systemd pose déjà un `PATH` explicite parce que celui d'un service est minimal,
 * et c'est ce même `PATH` que `spawn` consultera. Résoudre ailleurs annoncerait des CLI
 * que le daemon serait incapable de lancer.
 */

/** Ce qu'on sait d'un CLI, une fois cherché sur le disque. */
export type CliStatus =
  | { readonly found: true; readonly path: string; readonly version: string | null }
  | { readonly found: false; readonly reason: 'not_on_path' | 'not_executable' }

/** Durée de validité d'une sonde. Un CLI installé pendant que le daemon tourne
 *  doit finir par apparaître, sans pour autant relancer un process à chaque écran. */
const TTL_MS = 60_000

/** Fenêtre laissée au CLI pour annoncer sa version. Au-delà, on le dit présent
 *  mais muet : un binaire lent à démarrer reste utilisable. */
const VERSION_TIMEOUT_MS = 5_000

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
 */
export function resolveBinary(binary: string): string | null {
  if (isAbsolute(binary)) return isExecutable(binary) ? binary : null

  // Un nom contenant un séparateur est un chemin relatif, que `spawn` résoudrait
  // depuis le répertoire courant du daemon. Ce répertoire n'a rien à voir avec le
  // workspace des conversations, donc le réglage n'aurait pas de sens : on refuse.
  if (binary.includes('/')) return null

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, binary)
    if (isExecutable(candidate)) return candidate
  }
  return null
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
async function probeVersion(path: string): Promise<string | null> {
  try {
    const { stdout } = await run(path, ['--version'], { timeout: VERSION_TIMEOUT_MS })
    const line = stdout.trim().split('\n')[0]?.trim()
    if (!line) return null
    return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(line)?.[0] ?? line
  } catch {
    return null
  }
}

async function probe(binary: string): Promise<CliStatus> {
  const path = resolveBinary(binary)
  if (!path) {
    // Distinguer les deux cas vaut la peine : un binaire présent mais sans bit
    // d'exécution se répare d'un `chmod`, une absence demande une installation.
    return { found: false, reason: isAbsolute(binary) ? 'not_executable' : 'not_on_path' }
  }
  return { found: true, path, version: await probeVersion(path) }
}

/**
 * Sonde mise en cache pour un binaire donné.
 *
 * Une instance par adaptateur : le cache et la lecture unique en vol appartiennent au
 * CLI, pas à l'appelant.
 */
export class CliBinary {
  private readonly cache: CachedProbe<{ status: CliStatus }>

  constructor(readonly configured: string) {
    this.cache = new CachedProbe(TTL_MS, async () => ({ status: await probe(configured) }))
  }

  async status(force = false): Promise<CliStatus> {
    return (await this.cache.read(force)).status
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
