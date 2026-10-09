import { execFile } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { readdir, readFile, readlink, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { ServiceKind, ServiceProcessSummary } from '@sillage/protocol'
import { isShellCommand, summarizeCommand } from './command-line.js'
import type { ProcessOrigins } from './origins.js'
import { executionLink, readProcessHost, unifiedCgroup, type ProcessHost, type ProcessNode } from './ownership.js'

export interface ServiceProcess {
  id: string
  kind: ServiceKind
  pid: number
  name: string
  command: string | null
  parentPid: number
  parentName: string | null
  /** Le lanceur sous lequel ranger une commande ou un outil. */
  launcherPid: number | null
  stopsWithSillage: boolean
  cwd: string | null
  ports: number[]
  startedAt: number
  memoryBytes: number
  /** L'entrée et tout ce qui en descend. */
  processCount: number
  /** Les descendants par nom, du plus nombreux au plus rare. */
  processes: ServiceProcessSummary[]
  /** L'identité de chaque processus de l'arbre, pour n'arrêter que ceux-là. */
  members: { pid: number; start: string }[]
  origin: ReturnType<ProcessOrigins['resolve']>
}

export interface FoldableProcess extends ProcessNode {
  environment: string
  argv: string[]
}

interface ObservedProcess extends FoldableProcess {
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

function inheritedOrigin(pid: number, nodes: ReadonlyMap<number, FoldableProcess>, origins: ProcessOrigins, root: number) {
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

export interface FoldedEntry { kind: ServiceKind; launcherPid: number | null; members: number[] }

/**
 * Range chaque processus rattaché sous une entrée. Les racines sont les enfants directs
 * du daemon, leurs propres enfants et les orphelins ; tout le reste se replie sous la
 * racine dont il descend, pour qu'un `npm run dev` et ses dix sous-processus ne fassent
 * qu'une ligne. Sous un agent, un serveur MCP est un outil, pas une commande.
 */
export function foldProcesses(
  nodes: ReadonlyMap<number, FoldableProcess>, linked: ReadonlySet<number>, host: Pick<ProcessHost, 'pid'>, origins: ProcessOrigins,
): Map<number, FoldedEntry> {
  const entries = new Map<number, FoldedEntry>()
  const classify = (node: FoldableProcess): FoldedEntry | null => {
    if (node.parent === host.pid) return { kind: 'launcher', launcherPid: null, members: [] }
    const parent = nodes.get(node.parent)
    if (!parent || !linked.has(parent.pid)) return { kind: 'detached', launcherPid: null, members: [] }
    if (parent.parent !== host.pid) return null
    const agent = !!origins.resolve(parent.environment)?.conversationId
    const helper = agent && !isShellCommand(node.argv) && /mcp/i.test(node.argv.join(' '))
    return { kind: helper ? 'helper' : 'command', launcherPid: parent.pid, members: [] }
  }
  for (const pid of linked) {
    const node = nodes.get(pid)
    const entry = node && classify(node)
    if (entry) entries.set(pid, { ...entry, members: [pid] })
  }
  for (const pid of linked) {
    if (entries.has(pid)) continue
    const seen = new Set<number>()
    let cursor = nodes.get(pid)?.parent
    while (cursor !== undefined && !entries.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      cursor = nodes.get(cursor)?.parent
    }
    if (cursor !== undefined) entries.get(cursor)?.members.push(pid)
  }
  return entries
}

function summarize(names: string[]): ServiceProcessSummary[] {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
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
        const [identity, exe, status, cgroup, environment, cmdline] = await Promise.all([
          readFile(`${root}/stat`, 'utf8'), readlink(`${root}/exe`).catch(() => ''),
          readFile(`${root}/status`, 'utf8'), readFile(`${root}/cgroup`, 'utf8'),
          readFile(`${root}/environ`, 'utf8').catch(() => ''),
          readFile(`${root}/cmdline`, 'utf8').catch(() => ''),
        ])
        if (/^State:\s+Z/m.test(status)) continue
        nodes.set(pid, { pid, ...processIdentity(identity),
          name: basename(exe) || /^Name:\s+(.+)$/m.exec(status)?.[1] || String(pid),
          status, environment, argv: cmdline.split('\0').filter(Boolean), cgroup: unifiedCgroup(cgroup) })
      } catch { /* Le processus a pu disparaître pendant le scan. */ }
    }
  }))

  const linked = new Set([...nodes.keys()].filter((pid) => executionLink(pid, nodes, host)))
  const folded = foldProcesses(nodes, linked, host, origins)
  const roots = [...folded.entries()]
  const results: ServiceProcess[] = []
  cursor = 0
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (cursor < roots.length) {
      const [pid, entry] = roots[cursor++]!
      const node = nodes.get(pid)!
      const root = `/proc/${pid}`
      try {
        const ports = new Set<number>()
        const members: ServiceProcess['members'] = []
        let memoryBytes = 0
        for (const member of entry.members) {
          const current = nodes.get(member)!
          members.push({ pid: member, start: current.start })
          memoryBytes += Number(/^VmRSS:\s+(\d+)/m.exec(current.status)?.[1] ?? 0) * 1024
          for (const fd of await readdir(`/proc/${member}/fd`).catch(() => [] as string[])) {
            const target = await readlink(`/proc/${member}/fd/${fd}`).catch(() => '')
            const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
            const port = inode && sockets.get(inode)
            if (port) ports.add(port)
          }
        }
        const cwd = await readlink(`${root}/cwd`).catch(() => null)
        const after = processIdentity(await readFile(`${root}/stat`, 'utf8'))
        if (after.start !== node.start || after.parent !== node.parent) continue
        results.push({
          id: `${bootId.trim()}:${pid}:${node.start}`, kind: entry.kind, pid,
          // L'exécutable réel d'un CLI peut n'être qu'un numéro de version ; argv[0] porte le nom.
          name: basename(node.argv[0] ?? '') || node.name,
          command: summarizeCommand(node.argv),
          parentPid: node.parent, parentName: nodes.get(node.parent)?.name ?? null,
          launcherPid: entry.launcherPid,
          stopsWithSillage: host.stopsWithService && node.cgroup === host.cgroup,
          cwd, ports: [...ports].sort((a, b) => a - b),
          startedAt: Math.round(bootTime + Number(node.start) / hz * 1000),
          memoryBytes,
          processCount: entry.members.length,
          processes: summarize(entry.members.slice(1).map((member) => basename(nodes.get(member)!.argv[0] ?? '') || nodes.get(member)!.name)),
          members,
          origin: inheritedOrigin(pid, nodes, origins, host.pid),
        })
      } catch { /* Disparu ou devenu inaccessible : il sera revu au prochain scan. */ }
    }
  }))
  return results.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
}

/**
 * Revalide la racine, parenté comprise : un service transféré à tmux doit devenir
 * inarrêtable ici. Puis SIGTERM à chaque processus de l'arbre vu au scan, revérifié par
 * son instant de départ : un shell non interactif ne relaie pas le signal à ses enfants,
 * qui resteraient sinon comme processus détachés.
 */
export function stopServiceProcess(service: ServiceProcess, origins: ProcessOrigins, host: ProcessHost): boolean {
  if (!service.origin || service.kind === 'launcher' || service.kind === 'helper' || service.pid === host.pid) return false
  try {
    const nodes = new Map<number, FoldableProcess>()
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
      nodes.set(pid, { pid, ...identity, name, environment, argv: [],
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
    for (const member of service.members.length ? service.members : [{ pid: service.pid, start: identity.start }]) {
      try {
        if (processIdentity(readFileSync(`/proc/${member.pid}/stat`, 'utf8')).start === member.start) process.kill(member.pid, 'SIGTERM')
      } catch { /* Déjà parti, ou PID réattribué : on ne le vise pas. */ }
    }
    return true
  } catch { return false }
}
