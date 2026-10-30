import { execFile, spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { Logger } from 'electron-updater'

export interface InstallDirProcess {
  pid: number
  name: string
  path: string
}

/** Listing processes spawns PowerShell, which takes a second or two. */
const POLL_MS = 500

/**
 * Windows only. NSIS refuses to replace files a process still holds: it first tries to
 * stop whatever runs from the installation directory, then asks the user to close it,
 * and a cancel there can leave a half-replaced installation that no longer starts.
 * The server is stopped before installing, but CLIs and MCP servers it launched under
 * the bundled Node, or terminals it opened, may outlive it. Stop them ourselves and
 * hand over to the installer only when the directory is free.
 */
export async function releaseInstallDir(dir: string, log: Logger, timeoutMs: number): Promise<InstallDirProcess[]> {
  const deadline = Date.now() + timeoutMs
  let remaining = await processesUnder(dir)
  while (remaining.length > 0) {
    for (const found of remaining) {
      log.info(`stopping ${found.name} (${found.pid}) still running from ${found.path}`)
      // /T also stops its children, which may run from the directory too.
      spawnSync('taskkill', ['/pid', String(found.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    }
    if (Date.now() > deadline) break
    await delay(POLL_MS)
    remaining = await processesUnder(dir)
  }
  for (const found of remaining) log.warn(`${found.name} (${found.pid}) could not be stopped: ${found.path}`)
  return remaining
}

/** Processes whose executable lives under `dir`, excluding this application's own. */
export async function processesUnder(dir: string): Promise<InstallDirProcess[]> {
  const own = new Set([process.pid, ...app.getAppMetrics().map((metric) => metric.pid)])
  return selectUnder(await listProcesses(), dir, own)
}

export function selectUnder(rows: InstallDirProcess[], dir: string, excluded: Set<number>): InstallDirProcess[] {
  const prefix = (dir.endsWith(sep) ? dir : dir + sep).toLowerCase()
  return rows.filter((row) => !excluded.has(row.pid) && row.path.toLowerCase().startsWith(prefix))
}

async function listProcesses(): Promise<InstallDirProcess[]> {
  // Win32_Process exposes the executable path of the user's own processes, which is
  // all this application can have started. ConvertTo-Json would unwrap a lone object.
  const script =
    'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId, Name, ExecutablePath)'
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await promisify(execFile)(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.trim() || '[]') as { ProcessId?: unknown; Name?: unknown; ExecutablePath?: unknown }[]
  return rows
    .filter((row) => typeof row.ProcessId === 'number' && typeof row.ExecutablePath === 'string')
    .map((row) => ({ pid: row.ProcessId as number, name: String(row.Name ?? ''), path: row.ExecutablePath as string }))
}
