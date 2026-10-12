import { spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHECK_SKIP_EXIT_CODE,
  MAX_CHECK_OUTPUT_CHARS,
  type ScheduleCheckResultDto,
  type ScheduleCheckVerdict,
} from '@sillage/protocol'
import { agentProcessEnv } from '../agents/process-env.js'
import { serviceAppsAvailable } from '../services/apps.js'

/**
 * La vérification d'une tâche planifiée : un script joué par le daemon avant le tour
 * LLM, qui décide par son code de sortie s'il y a quelque chose à faire.
 *
 * Un exécutable et non un bac à sable : une vérification utile lance une commande, lit
 * un fichier, appelle le réseau, et un bac à sable qui permet tout cela ne protège plus
 * rien. La garde est ailleurs : le script vient de la base, et celui qu'un agent écrit
 * ne tourne pas avant qu'une personne l'ait validé.
 */

/** Ce que l'erreur standard garde, pour le débogage seulement. */
const MAX_STDERR_CHARS = 4000

/** Après le délai, le temps laissé au script pour se terminer proprement. */
const KILL_GRACE_MS = 3000

export interface CheckContext {
  taskId: string
  taskName: string
  projectId: string
  /** Dossier de travail du script : la racine du projet. */
  cwd: string
  /** Dossier propre à la tâche, conservé d'un tir à l'autre. */
  stateDir: string
  firedAt: number
  trigger: 'schedule' | 'manual' | 'test'
  previous: { startedAt: number; status: string } | null
  timeoutMs: number
}

/** Le dossier d'état d'une tâche, sous les données de Sillage et jamais dans le dépôt. */
export function checkStateDir(dataDir: string, taskId: string): string {
  return join(dataDir, 'schedule-state', taskId)
}

export function verdictOf(exitCode: number | null, timedOut: boolean): ScheduleCheckVerdict {
  if (timedOut || exitCode === null) return 'error'
  if (exitCode === 0) return 'launch'
  return exitCode === CHECK_SKIP_EXIT_CODE ? 'skip' : 'error'
}

/**
 * Joue le script et rend son verdict. Ne lève jamais : un script introuvable, un délai
 * dépassé ou un shell absent deviennent un verdict `error` lisible dans l'historique.
 *
 * Un essai (`trigger: 'test'`) travaille sur une copie du dossier d'état : un script qui
 * y note la dernière version vue ferait sinon écarter le vrai tir suivant.
 */
export async function runCheck(script: string, context: CheckContext): Promise<ScheduleCheckResultDto> {
  const started = Date.now()
  const workdir = await mkdtemp(join(tmpdir(), 'sillage-check-'))
  try {
    await mkdir(context.stateDir, { recursive: true })
    let stateDir = context.stateDir
    if (context.trigger === 'test') {
      stateDir = join(workdir, 'state')
      await cp(context.stateDir, stateDir, { recursive: true })
    }

    const file = join(workdir, 'check')
    await writeFile(file, script, { mode: 0o700 })
    await chmod(file, 0o700)
    // Sans shebang, le script est du shell : c'est ce qu'on écrit le plus souvent ici.
    const command = script.startsWith('#!') ? [file] : ['/bin/sh', file]

    const env = agentProcessEnv({
      SILLAGE_TASK_ID: context.taskId,
      SILLAGE_TASK_NAME: context.taskName,
      SILLAGE_PROJECT_ID: context.projectId,
      SILLAGE_PROJECT_DIR: context.cwd,
      SILLAGE_STATE_DIR: stateDir,
      SILLAGE_FIRED_AT: new Date(context.firedAt).toISOString(),
      SILLAGE_TRIGGER: context.trigger,
      SILLAGE_PREVIOUS_RUN_AT: context.previous ? new Date(context.previous.startedAt).toISOString() : '',
      SILLAGE_PREVIOUS_RUN_STATUS: context.previous?.status ?? '',
    })

    // Hors du cgroup du daemon quand systemd le permet : un script qui s'emballe en
    // mémoire ne doit pas geler Sillage, qui partage son plafond avec les sessions.
    const argv = (await serviceAppsAvailable())
      ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--description=Sillage check: ${context.taskName}`, '--', ...command]
      : command

    return await execute(argv, context.cwd, env, context.timeoutMs, started)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

function execute(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  started: number,
): Promise<ScheduleCheckResultDto> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (exitCode: number | null, extraError = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killer)
      const errorText = `${stderr}${extraError}`
      resolve({
        verdict: verdictOf(exitCode, timedOut),
        exitCode: timedOut ? null : exitCode,
        timedOut,
        stdout: clip(stdout, MAX_CHECK_OUTPUT_CHARS),
        stderr: clip(errorText, MAX_STDERR_CHARS),
        durationMs: Date.now() - started,
      })
    }

    // Un groupe de processus à lui : le délai doit emporter les commandes que le script
    // a lancées, pas seulement le shell.
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        // Déjà terminé.
      }
    }
    let killer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      killer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)

    // On garde un peu plus que le plafond pour savoir qu'il a été dépassé.
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length <= MAX_CHECK_OUTPUT_CHARS) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length <= MAX_STDERR_CHARS) stderr += chunk.toString()
    })
    child.on('error', (err) => finish(null, `Lancement impossible : ${err.message}`))
    child.on('close', (code) => finish(code))
  })
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… tronqué]`
}

/** La première ligne non vide, pour la raison affichée dans l'historique. */
export function firstLine(text: string): string | null {
  const line = text.split('\n').map((entry) => entry.trim()).find(Boolean)
  return line ? line.slice(0, 300) : null
}
