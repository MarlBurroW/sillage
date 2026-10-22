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
import { gitBash } from '../platform/shells.js'
import { killTree } from '../platform/process-tree.js'
import { serviceAppsAvailable } from '../services/apps.js'

/** Scheduled-task checks run scripts before LLM turns, using exit codes to decide whether work exists. Executables rather than sandboxes: useful checks run commands, read files and access networks, making permissive sandboxes pointless. Protection comes from stored scripts and mandatory human approval before agent-written scripts execute. */

/** Retained stderr for debugging only. */
const MAX_STDERR_CHARS = 4000

/** Grace period for scripts to exit cleanly after timeout. */
const KILL_GRACE_MS = 3000

export interface CheckContext {
  taskId: string
  taskName: string
  projectId: string
  /** Script working directory: project root. */
  cwd: string
  /** Task-specific directory retained between runs. */
  stateDir: string
  firedAt: number
  trigger: 'schedule' | 'manual' | 'test'
  previous: { startedAt: number; status: string } | null
  timeoutMs: number
}

/** Task state directory under Sillage data, never inside repositories. */
export function checkStateDir(dataDir: string, taskId: string): string {
  return join(dataDir, 'schedule-state', taskId)
}

export function verdictOf(exitCode: number | null, timedOut: boolean): ScheduleCheckVerdict {
  if (timedOut || exitCode === null) return 'error'
  if (exitCode === 0) return 'launch'
  return exitCode === CHECK_SKIP_EXIT_CODE ? 'skip' : 'error'
}

/** Runs checks and returns verdicts without throwing: missing scripts, timeouts and absent shells become historical `error` verdicts. Trials (`trigger: 'test'`) use copied state directories so recording latest versions cannot suppress subsequent real runs. */
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
    // Without shebangs, interpret as shell, the usual script format here.
    let command: string[]
    try {
      command = checkCommand(script, file)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { verdict: verdictOf(null, false), exitCode: null, timedOut: false, stdout: '', stderr: reason, durationMs: Date.now() - started }
    }

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

    // Run outside daemon cgroups when systemd supports it: runaway script memory
    // must not freeze Sillage, which shares limits with sessions.
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

    // Use dedicated process groups: timeouts must terminate spawned commands as well
    // as shells (see `killTree`, which uses another approach on Windows).
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) killTree(child.pid, signal)
    }
    let killer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      killer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)

    // Retain slightly beyond the cap to detect overflow.
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

/** Script execution command. On Windows, Git for Windows bash replaces `/bin/sh` and honors shebangs when present; without it scripts cannot run, deserving clear errors rather than obscure failures. */
function checkCommand(script: string, file: string): string[] {
  const shebang = script.startsWith('#!')
  if (process.platform !== 'win32') return shebang ? [file] : ['/bin/sh', file]
  const bash = gitBash()
  if (!bash) throw new Error('Git for Windows est introuvable : son bash exécute les scripts de vérification.')
  return shebang ? [bash, '-c', 'exec "$0"', file] : [bash, file]
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… tronqué]`
}

/** First nonempty line, used as the reason displayed in history. */
export function firstLine(text: string): string | null {
  const line = text.split('\n').map((entry) => entry.trim()).find(Boolean)
  return line ? line.slice(0, 300) : null
}
