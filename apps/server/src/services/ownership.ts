import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

export interface ProcessNode {
  pid: number
  parent: number
  start: string
  name: string
  cgroup: string | null
}

export interface ProcessHost {
  pid: number
  /** Only units whose main process really is Sillage. */
  cgroup: string | null
  stopsWithService: boolean
}

export function unifiedCgroup(contents: string): string | null {
  const line = contents.split('\n').find((entry) => entry.startsWith('0::') || entry.includes(':name=systemd:'))
  return line?.split(':').slice(2).join(':') || null
}

function unitPath(group: string | null): string | null {
  return group?.match(/^.*\.(?:service|scope)(?=\/|$)/)?.[0] ?? null
}

/** Inherited origins are not dependency links: execution ancestry is what matters. */
export function executionLink(pid: number, nodes: ReadonlyMap<number, ProcessNode>, host: ProcessHost): 'descendant' | 'service-group' | null {
  const first = nodes.get(pid)
  if (!first || pid === host.pid) return null
  if (host.cgroup && unitPath(first.cgroup) && unitPath(first.cgroup) !== unitPath(host.cgroup)) return null
  const visited = new Set<number>()
  let current: ProcessNode | undefined = first
  while (current && current.pid !== host.pid && !visited.has(current.pid)) {
    visited.add(current.pid)
    // Even tmux left in Sillage's cgroup is outside this view.
    if (/^(?:tmux(?:[: ].*)?|screen(?:-\d.*)?)$/.test(current.name)) return null
    if (current.name === 'systemd') break
    if (current.parent === host.pid) return 'descendant'
    const parent = nodes.get(current.parent)
    if (parent && BigInt(parent.start) > BigInt(current.start)) return null
    current = parent
  }
  // Shells may disappear after 'command &'. Cgroups remain evidence only when
  // stopping the unit actually terminates their processes.
  return host.stopsWithService && first.cgroup === host.cgroup ? 'service-group' : null
}

/** Never fall back to shared SSH-session, test or container cgroups. */
export async function readProcessHost(): Promise<ProcessHost> {
  const host: ProcessHost = { pid: process.pid, cgroup: null, stopsWithService: false }
  const cgroup = unifiedCgroup(await readFile('/proc/self/cgroup', 'utf8'))
  const unit = cgroup?.split('/').at(-1)
  if (!unit?.endsWith('.service')) return host
  try {
    const { stdout } = await promisify(execFile)('systemctl', [
      ...(cgroup!.includes('/user@') ? ['--user'] : []),
      'show', unit, '--property=MainPID,KillMode,ControlGroup',
    ], { timeout: 2000 })
    const properties = Object.fromEntries(stdout.trim().split('\n').map((line) => line.split('=')))
    if (Number(properties.MainPID) === process.pid && properties.ControlGroup === cgroup) {
      host.cgroup = cgroup
      host.stopsWithService = ['control-group', 'mixed'].includes(properties.KillMode ?? '')
    }
  } catch { /* Without systemd the parent-process chain remains usable. */ }
  return host
}
