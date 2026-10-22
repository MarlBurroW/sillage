/**
 * Entry kind: an agent or terminal (`launcher`), a launched command and all descendants
 * (`command`), an agent tool such as an MCP server (`helper`), or a process whose launcher
 * disappeared but remains held by Sillage's systemd service (`detached`).
 */
export type ServiceKind = 'launcher' | 'command' | 'helper' | 'detached'

export interface ServiceProcessSummary {
  name: string
  count: number
}

/** Processes still associated with Sillage's execution, with or without ports. */
export interface ServiceDto {
  id: string
  kind: ServiceKind
  pid: number
  name: string
  /** Shortened command line: CLI wrapper removed, paths shortened, secrets masked. */
  command: string | null
  parentPid: number
  parentName: string | null
  /** Launcher under which a command or tool is grouped. */
  launcherPid: number | null
  stopsWithSillage: boolean
  cwd: string | null
  ports: number[]
  startedAt: number
  memoryBytes: number
  /** The entry and all its descendants. */
  processCount: number
  /** Descendants grouped by name, most to least numerous. */
  processes: ServiceProcessSummary[]
  projectId: string | null
  projectName: string | null
  conversationId: string | null
  conversationTitle: string | null
  origin: 'agent' | 'terminal' | 'unknown'
  canStop: boolean
}

/**
 * Persistent app: a `sillage-app-*` user systemd unit created by an agent for services that
 * must outlive a session.
 */
export interface ServiceAppDto {
  /** Unit and invocation: if restarted since, it is no longer the same instance. */
  id: string
  unit: string
  /** Empty when systemd inferred it from the command, which it would duplicate. */
  description: string
  /** Executable only, like a process name. */
  executable: string | null
  /** Shortened command line with secrets masked, as for processes. */
  command: string | null
  /** systemd `ActiveState`. */
  state: 'active' | 'activating' | 'deactivating' | 'reloading' | 'failed' | 'inactive' | (string & {})
  subState: string
  result: string
  mainPid: number | null
  ports: number[]
  cwd: string | null
  startedAt: number | null
  memoryBytes: number | null
  /** Restarted when the user session opens, including after a reboot. */
  enabled: boolean
  transient: boolean
  projectId: string | null
  projectName: string | null
  conversationId: string | null
  conversationTitle: string | null
  origin: 'agent' | 'terminal' | 'unknown'
  canStop: boolean
  canRestart: boolean
  /** Remove a failed app from the list (`reset-failed`). */
  canReset: boolean
}

export type ServiceAppAction = 'stop' | 'restart' | 'reset'

export interface ServicesDto {
  supported: boolean
  scannedAt: number
  services: ServiceDto[]
  apps: ServiceAppDto[]
}
