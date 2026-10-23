import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

interface ProcessMemory { pid: number; parent: number; bytes: number }
/** Only numeric fields leave the OS probe: no commands, environment, names or paths. */
export function parseProcessMemory(raw: string, windows: boolean): ProcessMemory[] {
  if (windows) {
    const value: unknown = JSON.parse(raw)
    return (Array.isArray(value) ? value : [value]).flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const item = row as Record<string, unknown>
      const values = [item.ProcessId, item.ParentProcessId, item.WorkingSetSize].map(Number)
      return values.every(Number.isFinite) ? [{ pid: values[0]!, parent: values[1]!, bytes: values[2]! }] : []
    })
  }
  return raw.trim().split('\n').flatMap((line) => {
    const values = line.trim().split(/\s+/).map(Number)
    return values.length === 3 && values.every(Number.isFinite)
      ? [{ pid: values[0]!, parent: values[1]!, bytes: values[2]! * 1024 }] : []
  })
}

export function sumProcessTree(rows: ProcessMemory[], root: number) {
  const descendants = new Set([root])
  // Fixed point handles arbitrary OS listing order and guards against malformed parent cycles.
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows) if (!descendants.has(row.pid) && descendants.has(row.parent)) {
      descendants.add(row.pid); changed = true
    }
  }
  const children = rows.filter((row) => row.pid !== root && descendants.has(row.pid))
  return { serverRssBytes: rows.find((row) => row.pid === root)?.bytes ?? null,
    cliAndToolsRssBytes: children.reduce((sum, row) => sum + row.bytes, 0), cliAndToolsCount: children.length }
}

export async function sampleProcessTree(root: number) {
  const windows = process.platform === 'win32'
  const command = windows ? 'powershell.exe' : 'ps'
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress']
    : ['-axo', 'pid=,ppid=,rss=']
  const { stdout } = await promisify(execFile)(command, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' })
  return sumProcessTree(parseProcessMemory(stdout, windows), root)
}
