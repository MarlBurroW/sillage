import { execFile } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { readdir, readFile, readlink, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { ProcessOrigins } from './origins.js'
import { executionLink, readProcessHost, unifiedCgroup, type ProcessHost, type ProcessNode } from './ownership.js'

export interface ServiceProcess {
  id: string
  pid: number
  name: string
  parentPid: number
  parentName: string | null
  relation: 'descendant' | 'service-group'
  stopsWithSillage: boolean
  /** Les agents et shells porteurs se pilotent depuis leur interface dédiée. */
  launcher: boolean
  cwd: string | null
  ports: number[]
  startedAt: number
  memoryBytes: number
  origin: ReturnType<ProcessOrigins['resolve']>
}

interface ObservedProcess extends ProcessNode {
  environment: string
  status: string
}

/** Le nom peut contenir des espaces et des parenthèses. */
export function processIdentity(line: string): { parent: number; start: string } {
  const fields = line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Invalid process stat')
  return { parent: Number(fields[1]), start: fields[19]! }
}

export function listeningSockets(table: string): Map<string, number> {
  const sockets = new Map<string, number>()
  for (const line of table.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields[3] !== '0A' || !fields[9]) continue
    const port = parseInt(fields[1]!.split(':')[1]!, 16)
    if (port > 0) sockets.set(fields[9], port)
  }
  return sockets
}

let clockTicks: Promise<number> | undefined
function ticks(): Promise<number> {
  return clockTicks ??= promisify(execFile)('getconf', ['CLK_TCK'])
    .then(({ stdout }) => Number(stdout.trim()) || 100).catch(() => 100)
}

function inheritedOrigin(pid: number, nodes: ReadonlyMap<number, ObservedProcess>, origins: ProcessOrigins, root: number) {
  const seen = new Set<number>()
  while (pid !== root && !seen.has(pid)) {
    seen.add(pid)
    const node = nodes.get(pid)
    if (!node) break
    const origin = origins.resolve(node.environment)
    if (origin) return origin
    pid = node.parent
  }
  return null
}

/** L'origine sert à nommer le projet, jamais à décider qu'un processus dépend de Sillage. */
export async function scanServiceProcesses(origins: ProcessOrigins): Promise<ServiceProcess[]> {
  const [tcp, tcp6, uptime, bootId, hz, entries, host] = await Promise.all([
    readFile('/proc/net/tcp', 'utf8').catch(() => ''),
    readFile('/proc/net/tcp6', 'utf8').catch(() => ''),
    readFile('/proc/uptime', 'utf8'),
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ticks(), readdir('/proc'), readProcessHost(),
  ])
  const sockets = new Map([...listeningSockets(tcp), ...listeningSockets(tcp6)])
  const bootTime = Date.now() - Number(uptime.split(' ')[0]) * 1000
  const pids = entries.filter((entry) => /^\d+$/.test(entry))
  const nodes = new Map<number, ObservedProcess>()
  let cursor = 0

  // D'abord la parenté complète, puis les détails des seuls processus rattachés.
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (cursor < pids.length) {
      const pid = Number(pids[cursor++])
      const root = `/proc/${pid}`
      try {
        if ((await stat(root)).uid !== process.getuid?.()) continue
        const [identity, exe, status, cgroup, environment] = await Promise.all([
          readFile(`${root}/stat`, 'utf8'), readlink(`${root}/exe`).catch(() => ''),
          readFile(`${root}/status`, 'utf8'), readFile(`${root}/cgroup`, 'utf8'),
          readFile(`${root}/environ`, 'utf8').catch(() => ''),
        ])
        if (/^State:\s+Z/m.test(status)) continue
        nodes.set(pid, { pid, ...processIdentity(identity),
          name: basename(exe) || /^Name:\s+(.+)$/m.exec(status)?.[1] || String(pid),
          status, environment, cgroup: unifiedCgroup(cgroup) })
      } catch { /* Le processus a pu disparaître pendant le scan. */ }
    }
  }))

  const results: ServiceProcess[] = []
  const candidates = [...nodes.values()].filter((node) => executionLink(node.pid, nodes, host))
  cursor = 0
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (cursor < candidates.length) {
      const node = candidates[cursor++]!
      const root = `/proc/${node.pid}`
      try {
        const ports = new Set<number>()
        for (const fd of await readdir(`${root}/fd`)) {
          const target = await readlink(`${root}/fd/${fd}`).catch(() => '')
          const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
          const port = inode && sockets.get(inode)
          if (port) ports.add(port)
        }
        const cwd = await readlink(`${root}/cwd`).catch(() => null)
        const after = processIdentity(await readFile(`${root}/stat`, 'utf8'))
        if (after.start !== node.start || after.parent !== node.parent) continue
        results.push({
          id: `${bootId.trim()}:${node.pid}:${node.start}`, pid: node.pid, name: node.name,
          parentPid: node.parent, parentName: nodes.get(node.parent)?.name ?? null,
          relation: executionLink(node.pid, nodes, host)!,
          stopsWithSillage: host.stopsWithService && node.cgroup === host.cgroup,
          launcher: node.parent === host.pid,
          cwd, ports: [...ports].sort((a, b) => a - b),
          startedAt: Math.round(bootTime + Number(node.start) / hz * 1000),
          memoryBytes: Number(/^VmRSS:\s+(\d+)/m.exec(node.status)?.[1] ?? 0) * 1024,
          origin: inheritedOrigin(node.pid, nodes, origins, host.pid),
        })
      } catch { /* Disparu ou devenu inaccessible : il sera revu au prochain scan. */ }
    }
  }))
  return results.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
}

/** Revalide aussi la parenté : un service transféré à tmux doit devenir inarrêtable ici. */
export function stopServiceProcess(service: ServiceProcess, origins: ProcessOrigins, host: ProcessHost): boolean {
  if (!service.origin || service.launcher || service.pid === host.pid) return false
  try {
    const nodes = new Map<number, ObservedProcess>()
    let pid = service.pid
    while (pid > 0 && pid !== host.pid && !nodes.has(pid)) {
      const root = `/proc/${pid}`
      const rawIdentity = readFileSync(`${root}/stat`, 'utf8')
      const identity = processIdentity(rawIdentity)
      let name = rawIdentity.slice(rawIdentity.indexOf('(') + 1, rawIdentity.lastIndexOf(')'))
      let environment = ''
      // Le subreaper systemd peut être non dumpable : stat/cgroup restent lisibles,
      // contrairement à exe/environ. Cela n'annule pas la preuve du cgroup enfant.
      try { name = basename(readlinkSync(`${root}/exe`)) } catch { /* Nom de stat. */ }
      try { environment = readFileSync(`${root}/environ`, 'utf8') } catch { /* Pas d'origine disponible. */ }
      nodes.set(pid, { pid, ...identity,
        name, status: '', environment,
        cgroup: unifiedCgroup(readFileSync(`${root}/cgroup`, 'utf8')) })
      if (name === 'systemd') break
      if (identity.parent <= 1) break
      pid = identity.parent
    }
    const identity = nodes.get(service.pid)!
    const origin = inheritedOrigin(service.pid, nodes, origins, host.pid)
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (`${bootId}:${service.pid}:${identity.start}` !== service.id ||
      identity.parent === host.pid || !executionLink(service.pid, nodes, host) ||
      origin?.projectId !== service.origin.projectId || origin?.conversationId !== service.origin.conversationId) return false
    process.kill(service.pid, 'SIGTERM')
    return true
  } catch { return false }
}
