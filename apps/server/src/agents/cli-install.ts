import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { TESTED_CLI_RELEASES, type AgentKind, type CliInstallStateDto } from '@sillage/protocol'

/**
 * Installation des CLI agents par Sillage lui-même.
 *
 * Les binaires ne viennent plus de la release, donc un serveur fraîchement installé peut
 * n'avoir aucun CLI. Plutôt que de renvoyer l'utilisateur à un terminal qu'il n'a pas
 * toujours (image Docker, machine distante), Sillage sait poser la version sur laquelle
 * il est testé, dans un préfixe npm qui lui appartient.
 *
 * En tâche de fond, et non dans la requête : le paquet pèse plusieurs centaines de
 * mégaoctets, et une installation qui tient dans le temps d'une requête HTTP tiendrait
 * par chance. L'état se consulte, il ne se retourne pas.
 */

/** Fenêtre au-delà de laquelle on considère l'installation perdue plutôt que lente. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Sortie d'erreur conservée en cas d'échec. Assez pour diagnostiquer, pas assez pour
 * qu'un `npm` bavard remplisse la mémoire du daemon.
 */
const MAX_ERROR_CHARS = 4_000

type State =
  | { status: 'idle' }
  | { status: 'running'; version: string; startedAt: number }
  | { status: 'failed'; version: string; error: string; at: number }

export class CliInstaller {
  /** Un état par agent. Absent vaut « jamais tenté », que `state()` rend comme `idle`. */
  private readonly states = new Map<AgentKind, State>()

  constructor(private readonly prefix: string) {}

  state(kind: AgentKind): CliInstallStateDto {
    const state = this.states.get(kind) ?? { status: 'idle' }
    return state.status === 'failed'
      ? { status: 'failed', version: state.version, error: state.error }
      : state.status === 'running'
        ? { status: 'running', version: state.version }
        : { status: 'idle' }
  }

  /**
   * Lance l'installation et rend la main aussitôt.
   *
   * Retourne faux si une installation de ce CLI tourne déjà : deux `npm install`
   * concurrents sur le même préfixe se marcheraient dessus, et rien ne garantit
   * laquelle des deux versions survivrait.
   */
  start(kind: AgentKind): boolean {
    if (this.states.get(kind)?.status === 'running') return false

    const { package: pkg, version } = TESTED_CLI_RELEASES[kind]
    this.states.set(kind, { status: 'running', version, startedAt: Date.now() })
    void this.run(kind, pkg, version)
    return true
  }

  private async run(kind: AgentKind, pkg: string, version: string): Promise<void> {
    try {
      // npm refuse d'installer dans un préfixe inexistant. Le créer ici plutôt qu'au
      // démarrage : le dossier n'a de raison d'exister que si on installe.
      await mkdir(this.prefix, { recursive: true })
      await this.npm(pkg, version)
      this.states.set(kind, { status: 'idle' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.states.set(kind, {
        status: 'failed',
        version,
        error: message.slice(0, MAX_ERROR_CHARS),
        at: Date.now(),
      })
    }
  }

  private npm(pkg: string, version: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // `--prefix` plutôt que la configuration npm de l'utilisateur : Sillage installe
      // chez lui, et ne doit pas déplacer ce qui est déjà installé sur le système.
      // `--no-fund --no-audit` parce que rien ne lit cette sortie.
      const child = execFile(
        'npm',
        ['install', '-g', '--prefix', this.prefix, '--no-fund', '--no-audit', `${pkg}@${version}`],
        { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (!err) return resolve()
          // La sortie d'erreur de npm dit ce qui a échoué (réseau, droits, version
          // inconnue) ; le message d'`execFile` seul ne dirait que « exited with 1 ».
          reject(new Error(stderr.trim() || err.message))
        },
      )
      child.on('error', (err) =>
        reject(
          // `npm` absent du PATH est le cas le plus probable sur un serveur minimal, et
          // « spawn npm ENOENT » n'apprend rien à qui lit ça depuis une interface web.
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? new Error("npm est introuvable sur le serveur : impossible d'installer un CLI.")
            : err,
        ),
      )
    })
  }
}
