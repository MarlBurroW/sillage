import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { ServiceAppAction } from '@sillage/protocol'
import { summarizeCommand } from './command-line.js'
import type { ProcessOrigins } from './origins.js'
import { listeningSockets } from './processes.js'

/**
 * Apps permanentes : les unités systemd utilisateur `sillage-app-*`.
 *
 * Une commande lancée en fond par un agent est temporaire (Claude Code l'arrête au bout
 * de son délai, et elle meurt avec la session). Ce qui doit rester en ligne passe par
 * une unité systemd que l'agent nomme avec ce préfixe, comme le demande la partie
 * globale de SILLAGE.md. Elle sort du service Sillage par construction, pour lui
 * survivre : la vue des processus ne la voit donc pas, d'où cette liste à part.
 *
 * Le préfixe dit seulement « Sillage peut montrer et arrêter ceci ». L'attribution à un
 * projet suit la même règle que les processus : le jeton `SILLAGE_PROCESS_ORIGIN` que
 * l'agent transmet à l'unité (`--setenv=SILLAGE_PROCESS_ORIGIN`), jamais le dossier.
 */

export const APP_UNIT_PATTERN = 'sillage-app-*'
/** Ce que l'API accepte de piloter : le préfixe, et rien qui ressemble à une option. */
const APP_UNIT = /^sillage-app-[A-Za-z0-9_.@-]+\.service$/

export interface ServiceApp {
  /** L'unité et son invocation : une unité relancée entre la liste et le clic n'est plus la même. */
  id: string
  unit: string
  /** Écrite par l'auteur d'un fichier d'unité ; vide pour celle que `systemd-run` déduit de la commande. */
  description: string
  /** Nom de l'exécutable seul, comme le nom d'un processus. */
  executable: string | null
  /** Ligne de commande abrégée, secrets masqués, comme pour un processus. */
  command: string | null
  /** `ActiveState` de systemd : active, activating, deactivating, reloading, failed, inactive. */
  state: string
  subState: string
  /** `Result` de systemd, qui nomme la cause d'un échec (`exit-code`, `signal`…). */
  result: string
  mainPid: number | null
  ports: number[]
  cwd: string | null
  startedAt: number | null
  memoryBytes: number | null
  /** Activée au démarrage de la session utilisateur : elle reviendra après un arrêt et un redémarrage. */
  enabled: boolean
  transient: boolean
  origin: ReturnType<ProcessOrigins['resolve']>
}

const systemctl = (args: string[]) =>
  promisify(execFile)('systemctl', ['--user', '--no-pager', ...args], { timeout: 5000 })

/** Les blocs de `systemctl show`, une unité par bloc, séparés par une ligne vide. */
export function parseShow(output: string): Record<string, string>[] {
  return output.split(/\n\s*\n/).filter((block) => block.trim()).map((block) => {
    const properties: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) properties[line.slice(0, at)] = line.slice(at + 1)
    }
    return properties
  })
}

/** Le jeton d'origine posé par `--setenv` ou `Environment=`, lisible même unité arrêtée. */
export function originToken(environment: string): string | null {
  return /(?:^|\s)"?SILLAGE_PROCESS_ORIGIN=([0-9a-f-]{36})/.exec(environment)?.[1] ?? null
}

/** Le nom de l'exécutable d'`ExecStart`. */
export function executableName(execStart: string): string | null {
  return basename(/path=(\S+) ;/.exec(execStart)?.[1] ?? '') || null
}

/** Les arguments d'`ExecStart` ; systemd les joint par des espaces, sans les citer. */
export function execStartArgv(execStart: string): string[] {
  return (/argv\[\]=(.*?) ; ignore_errors=/.exec(execStart)?.[1] ?? '').split(' ').filter(Boolean)
}

/**
 * La description générée par `systemd-run` recopie les arguments sans masquer les
 * secrets. Les anciens systemd n'ajoutent pas « [systemd-run] » : on reconnaît aussi
 * la commande d'ExecStart, avec son chemin résolu ou son nom d'origine.
 */
export function authoredDescription(description: string, execStart = ''): string {
  if (description.startsWith('[systemd-run]')) return ''
  const executable = /path=(\S+) ;/.exec(execStart)?.[1]
  const command = execStartArgv(execStart)[0]
  for (const prefix of [executable, command]) {
    if (prefix && (description === prefix || description.startsWith(`${prefix} `))) return ''
  }
  return description
}

/** Valeur numérique de systemd, nulle quand il ne la suit pas (`[not set]`, 2^64 - 1). */
function counter(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value) || value === '18446744073709551615') return null
  return Number(value)
}

async function cgroupPorts(controlGroup: string, sockets: Map<string, number>): Promise<number[]> {
  if (!controlGroup) return []
  const procs = await readFile(`/sys/fs/cgroup${controlGroup}/cgroup.procs`, 'utf8').catch(() => '')
  const ports = new Set<number>()
  for (const pid of procs.split('\n').filter(Boolean)) {
    for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
      const port = inode && sockets.get(inode)
      if (port) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

/** Vide sans gestionnaire systemd utilisateur : rien à montrer n'est pas une erreur. */
export async function scanServiceApps(origins: ProcessOrigins): Promise<ServiceApp[]> {
  let names: string[]
  try {
    const { stdout } = await systemctl(['list-units', '--type=service', '--all', '--plain', '--no-legend', APP_UNIT_PATTERN])
    names = stdout.split('\n').map((line) => line.trim().split(/\s+/)[0] ?? '').filter((name) => APP_UNIT.test(name))
  } catch { return [] }
  if (names.length === 0) return []

  const [{ stdout }, tcp, tcp6, uptime] = await Promise.all([
    systemctl(['show', ...names, '--property=Id,Description,LoadState,ActiveState,SubState,Result,MainPID,ControlGroup,WorkingDirectory,MemoryCurrent,ActiveEnterTimestampMonotonic,UnitFileState,Transient,InvocationID,Environment,ExecStart']),
    readFile('/proc/net/tcp', 'utf8').catch(() => ''),
    readFile('/proc/net/tcp6', 'utf8').catch(() => ''),
    readFile('/proc/uptime', 'utf8'),
  ])
  const sockets = new Map([...listeningSockets(tcp), ...listeningSockets(tcp6)])
  const bootTime = Date.now() - Number(uptime.split(' ')[0]) * 1000

  const apps: ServiceApp[] = []
  for (const unit of parseShow(stdout)) {
    if (!unit.Id || !APP_UNIT.test(unit.Id) || unit.LoadState !== 'loaded') continue
    const running = ['active', 'activating', 'deactivating', 'reloading'].includes(unit.ActiveState ?? '')
    const mainPid = counter(unit.MainPID) || null
    const token = originToken(unit.Environment ?? '')
    // Repli sur l'environnement du processus principal, qu'un `EnvironmentFile=` aurait garni.
    const environ = !token && mainPid ? await readFile(`/proc/${mainPid}/environ`, 'utf8').catch(() => '') : ''
    const monotonic = counter(unit.ActiveEnterTimestampMonotonic)
    apps.push({
      id: `${unit.Id}#${unit.InvocationID ?? ''}`,
      unit: unit.Id,
      description: authoredDescription(unit.Description ?? '', unit.ExecStart ?? ''),
      executable: executableName(unit.ExecStart ?? ''),
      command: summarizeCommand(execStartArgv(unit.ExecStart ?? '')),
      state: unit.ActiveState ?? 'unknown',
      subState: unit.SubState ?? '',
      result: unit.Result ?? '',
      mainPid,
      ports: running ? await cgroupPorts(unit.ControlGroup ?? '', sockets) : [],
      // `!` ou `-` en tête sont des modificateurs de systemd, pas une partie du chemin.
      cwd: unit.WorkingDirectory?.replace(/^[!-]+/, '') || null,
      startedAt: running && monotonic ? Math.round(bootTime + monotonic / 1000) : null,
      memoryBytes: running ? counter(unit.MemoryCurrent) : null,
      enabled: (unit.UnitFileState ?? '').startsWith('enabled'),
      transient: unit.Transient === 'yes',
      origin: token ? origins.byToken(token) : origins.resolve(environ),
    })
  }
  return apps.sort((a, b) => a.unit.localeCompare(b.unit))
}

/**
 * Arrêter, relancer, ou retirer de la liste une app en échec (`reset-failed`). Le nom
 * est revérifié ici même si la route l'a trouvé dans la liste : c'est la dernière
 * barrière avant `systemctl`, appelé sans shell.
 */
export async function controlServiceApp(unit: string, action: ServiceAppAction): Promise<void> {
  if (!APP_UNIT.test(unit)) throw new Error(`Not a Sillage app unit: ${unit}`)
  // Sans attendre la fin : une app peut mettre jusqu'à son `TimeoutStopSec` à s'arrêter,
  // et la liste, rafraîchie toutes les 5 secondes, dira où elle en est.
  await systemctl(action === 'reset' ? ['reset-failed', unit] : ['--no-block', action, unit])
}

let userManager: Promise<boolean> | null = null

/**
 * Un gestionnaire systemd utilisateur répond-il ? Non sous macOS, ni dans un conteneur
 * sans systemd : les actions `service` y retombent dans un terminal. Demandé une fois
 * par process, la réponse ne change pas sans redémarrage de la machine.
 */
export function serviceAppsAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return Promise.resolve(false)
  userManager ??= systemctl(['show-environment']).then(() => true, () => false)
  return userManager
}

export interface ServiceAppLaunch {
  unit: string
  description: string
  cwd: string
  shell: string
  command: string
  /** L'origine (`SILLAGE_PROCESS_ORIGIN`) : c'est elle qui rattache l'app au projet dans Services. */
  env: Record<string, string>
}

/**
 * Démarre une commande comme unité transitoire `sillage-app-*`, hors du cgroup du
 * daemon : elle lui survit, et le plafond mémoire du service ne s'applique pas à elle.
 *
 * Relancée sur échec, mais pas indéfiniment : un serveur qui ne trouve pas son port
 * s'arrête au bout de quatre essais en une minute et reste `failed`, lisible dans
 * Services, au lieu de boucler en silence.
 */
export async function startServiceApp(launch: ServiceAppLaunch): Promise<void> {
  if (!APP_UNIT.test(launch.unit)) throw new Error(`Not a Sillage app unit: ${launch.unit}`)
  // Une unité transitoire en échec reste chargée et bloquerait le nom.
  await systemctl(['reset-failed', launch.unit]).catch(() => undefined)
  await promisify(execFile)('systemd-run', [
    '--user',
    `--unit=${launch.unit}`,
    `--description=${launch.description}`,
    `--working-directory=${launch.cwd}`,
    // Le PATH du daemon : sans lui, l'unité n'a que celui, minimal, du gestionnaire.
    '--setenv=PATH',
    ...Object.entries(launch.env).map(([key, value]) => `--setenv=${key}=${value}`),
    '-p', 'Restart=on-failure',
    '-p', 'RestartSec=3',
    '-p', 'StartLimitIntervalSec=60',
    '-p', 'StartLimitBurst=4',
    launch.shell, '-lc', launch.command,
  ], { timeout: 10000 })
}
