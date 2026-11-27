import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { BackgroundTask, BackgroundTaskOutput } from '@sillage/protocol'
import { fields } from './tools.js'

/**
 * Grok's background work (probed on 1.0.62 and 1.0.94). `_x.ai/session_notification`
 * `background_tasks` republishes the whole list of a session at each change: `{task_id, command,
 * description, kind: "bash", status: running|completed, output_file, exit_code…}`. Each task's
 * output goes to `output_file`, under `$GROK_HOME/sessions/<cwd>/<session>/terminal/`. The doc of
 * 1.0.94 adds monitors, `/loop` and the scheduler to the same list.
 */

/** Same tail as Claude's task output and OpenCode's shells. */
const OUTPUT_TAIL_BYTES = 8192

export interface GrokBackgroundTask extends BackgroundTask {
  outputFile: string | null
}

/** What still runs in one `background_tasks` list; `parentTaskId` when a sub-agent launched it. */
export function runningTasks(update: Record<string, unknown>, parentTaskId?: string): GrokBackgroundTask[] {
  const tasks = Array.isArray(update.tasks) ? update.tasks : []
  return tasks.flatMap((entry): GrokBackgroundTask[] => {
    const task = fields(entry)
    if (typeof task.task_id !== 'string' || task.status !== 'running') return []
    const kind = typeof task.kind === 'string' ? task.kind : 'shell'
    const description = [task.description, task.command].find((value): value is string => typeof value === 'string' && value !== '') ?? task.task_id
    return [{
      id: task.task_id,
      kind: kind === 'bash' ? 'shell' : kind,
      description,
      ...(parentTaskId ? { parentTaskId } : {}),
      outputFile: typeof task.output_file === 'string' ? task.output_file : null,
    }]
  })
}

/** Output files named in a `background_tasks` list, ended tasks included: their output stays readable. */
export function outputFiles(update: Record<string, unknown>): [string, string][] {
  const tasks = Array.isArray(update.tasks) ? update.tasks : []
  return tasks.flatMap((entry): [string, string][] => {
    const task = fields(entry)
    return typeof task.task_id === 'string' && typeof task.output_file === 'string' ? [[task.task_id, task.output_file]] : []
  })
}

/** The session's `GROK_HOME`: an account's, or the CLI's own. */
export function grokHome(env: Record<string, string | undefined> | undefined): string {
  return env?.GROK_HOME || process.env.GROK_HOME || join(homedir(), '.grok')
}

/**
 * Last 8 KiB of a task's output, read from the file Grok writes without asking the CLI. The path
 * comes from Grok's own notifications; it is still held to the sessions of the session's
 * `GROK_HOME`, links resolved (an account's home links to the user's). Null when the file is gone.
 */
export async function readOutputTail(file: string, home: string): Promise<BackgroundTaskOutput | null> {
  let resolved: string
  let root: string
  try {
    resolved = await realpath(file)
    root = await realpath(join(home, 'sessions'))
  } catch {
    return null
  }
  if (!resolved.startsWith(root + sep)) return null
  const handle = await open(resolved, 'r').catch(() => null)
  if (!handle) return null
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - OUTPUT_TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    // A cut through a multi-byte character decodes as a replacement character: drop it.
    const output = buffer.toString('utf8').replace(start > 0 ? /^�+/ : /^$/, '')
    return { output, totalBytes: size, truncated: start > 0 }
  } finally {
    await handle.close()
  }
}
