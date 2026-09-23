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
  /** Seulement une unité dont Sillage est bien le processus principal. */
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

/** Une origine héritée n'est pas un lien de dépendance : seule l'exécution compte. */
export function executionLink(pid: number, nodes: ReadonlyMap<number, ProcessNode>, host: ProcessHost): 'descendant' | 'service-group' | null {
  const first = nodes.get(pid)
  if (!first || pid === host.pid) return null
  if (host.cgroup && unitPath(first.cgroup) && unitPath(first.cgroup) !== unitPath(host.cgroup)) return null
  const visited = new Set<number>()
  let current: ProcessNode | undefined = first
  while (current && current.pid !== host.pid && !visited.has(current.pid)) {
    visited.add(current.pid)
    // Même un tmux resté dans le cgroup de Sillage est hors de cette vue.
    if (/^(?:tmux(?:[: ].*)?|screen(?:-\d.*)?)$/.test(current.name)) return null
    if (current.name === 'systemd') break
    if (current.parent === host.pid) return 'descendant'
    const parent = nodes.get(current.parent)
    if (parent && BigInt(parent.start) > BigInt(current.start)) return null
    current = parent
  }
  // Un shell peut disparaître après « commande & ». Le cgroup reste une preuve,
  // mais uniquement si l'arrêt de l'unité emporte effectivement ses processus.
  return host.stopsWithService && first.cgroup === host.cgroup ? 'service-group' : null
}

/** Pas de repli sur le cgroup de la session SSH, d'un test ou d'un conteneur partagé. */
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
  } catch { /* Sans systemd, la chaîne des parents reste utilisable. */ }
  return host
}
