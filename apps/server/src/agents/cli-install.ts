import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import {
  PREFERRED_CLI_RELEASES,
  type AgentKind,
  type CliInstallStateDto,
} from '@sillage/protocol'
import { resolveBinary } from './cli-binary.js'
import { launchOf } from './launch.js'

/**
 * Installation des CLI agents par Sillage lui-même.
 *
 * Les binaires ne viennent plus de la release, donc un serveur fraîchement installé peut
 * n'avoir aucun CLI. Plutôt que de renvoyer l'utilisateur à un terminal qu'il n'a pas
 * toujours (image Docker, machine distante), Sillage sait poser la version qu'il vise, dans un préfixe npm qui lui appartient.
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

/**
 * Une requête au registre, telle que npm la journalise au niveau `http` :
 * `npm http fetch GET 200 https://registry.npmjs.org/…/claude-code-2.1.301.tgz 1532ms`.
 * C'est le seul signe de vie que npm donne sans terminal ; sa barre d'avancement
 * suppose un TTY, et le niveau par défaut se tait jusqu'au bilan final.
 */
const FETCH_LINE = /^npm (?:http|verb http) fetch \w+ \d+ (\S+)/
/** Les lignes d'erreur, au format d'npm 10 (`npm error`) comme d'npm 9 (`npm ERR!`). */
const ERROR_LINE = /^npm (?:error|ERR!)\b/

type State =
  | { status: 'idle' }
  | { status: 'running'; version: string; startedAt: number; fetched: number; current: string | null }
  | { status: 'failed'; version: string; error: string; at: number }

export class CliInstaller {
  /** Un état par agent. Absent vaut « jamais tenté », que `state()` rend comme `idle`. */
  private readonly states = new Map<AgentKind, State>()

  constructor(
    private readonly prefix: string,
    /**
     * Prévenu quand un CLI vient d'être posé. La sonde de présence est en cache, et sans
     * ce signal elle dirait « absent » jusqu'à son expiration : l'écran reviendrait au
     * bouton « Installer » juste après l'installation, comme si rien ne s'était passé.
     */
    private readonly onInstalled: (kind: AgentKind) => void = () => {},
  ) {}

  state(kind: AgentKind): CliInstallStateDto {
    const state = this.states.get(kind) ?? { status: 'idle' }
    return state.status === 'failed'
      ? { status: 'failed', version: state.version, error: state.error }
      : state.status === 'running'
        ? {
            status: 'running',
            version: state.version,
            startedAt: state.startedAt,
            fetched: state.fetched,
            current: state.current,
          }
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

    const { package: pkg, version } = PREFERRED_CLI_RELEASES[kind]
    this.states.set(kind, { status: 'running', version, startedAt: Date.now(), fetched: 0, current: null })
    void this.run(kind, pkg, version)
    return true
  }

  private async run(kind: AgentKind, pkg: string, version: string): Promise<void> {
    try {
      // npm refuse d'installer dans un préfixe inexistant. Le créer ici plutôt qu'au
      // démarrage : le dossier n'a de raison d'exister que si on installe.
      await mkdir(this.prefix, { recursive: true })
      await this.npm(kind, pkg, version)
      this.onInstalled(kind)
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

  /** Note une requête de plus au registre, pour que l'écran voie l'installation avancer. */
  private progress(kind: AgentKind, url: string): void {
    const state = this.states.get(kind)
    if (state?.status !== 'running') return
    // Le nom du fichier suffit : l'URL complète du registre n'apprend rien de plus et
    // ne tient pas sur une ligne d'interface.
    const current = url.slice(url.lastIndexOf('/') + 1) || null
    this.states.set(kind, { ...state, fetched: state.fetched + 1, current })
  }

  private npm(kind: AgentKind, pkg: string, version: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // `--prefix` plutôt que la configuration npm de l'utilisateur : Sillage installe
      // chez lui, et ne doit pas déplacer ce qui est déjà installé sur le système.
      // `--no-fund --no-audit` parce que rien ne lit cette sortie.
      // `--loglevel=http` pour que npm raconte ses téléchargements : c'est ce que
      // l'écran montre pendant les minutes que dure l'installation.
      // npm se cherche comme un CLI : sous Windows c'est un lanceur `npm.cmd`, que Node ne
      // lance pas sans shell. L'app de bureau en embarque un, placé en dernier dans le PATH.
      const npm = resolveBinary('npm')
      if (!npm) {
        reject(new Error("npm est introuvable sur le serveur : impossible d'installer un CLI."))
        return
      }
      const launch = launchOf(npm)
      const child = spawn(
        launch.command,
        [
          ...launch.args,
          'install',
          '-g',
          '--prefix',
          this.prefix,
          '--no-fund',
          '--no-audit',
          '--no-progress',
          '--loglevel=http',
          `${pkg}@${version}`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: INSTALL_TIMEOUT_MS, windowsHide: true },
      )

      // Seules les lignes d'erreur sont gardées : le journal des requêtes, lui, ne vaut
      // que pendant l'installation, et un paquet de plusieurs centaines de fichiers en
      // produirait plus que la limite ne permet d'en conserver.
      const errors: string[] = []
      let pending = ''
      let errorChars = 0
      const onLine = (line: string) => {
        const fetch = FETCH_LINE.exec(line)
        if (fetch?.[1]) {
          this.progress(kind, fetch[1])
        } else if (ERROR_LINE.test(line) && errorChars < MAX_ERROR_CHARS) {
          errors.push(line)
          errorChars += line.length + 1
        }
      }
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })

      child.on('error', (err) =>
        reject(
          // `npm` absent du PATH est le cas le plus probable sur un serveur minimal, et
          // « spawn npm ENOENT » n'apprend rien à qui lit ça depuis une interface web.
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? new Error("npm est introuvable sur le serveur : impossible d'installer un CLI.")
            : err,
        ),
      )
      child.on('close', (code, signal) => {
        if (pending) onLine(pending)
        if (code === 0) return resolve()
        // La sortie d'erreur de npm dit ce qui a échoué (réseau, droits, version
        // inconnue) ; le code de sortie seul ne dirait que « exited with 1 ».
        reject(
          new Error(
            errors.join('\n') ||
              (signal ? `npm interrompu par ${signal}` : `npm a échoué (code ${code ?? '?'})`),
          ),
        )
      })
    })
  }
}
