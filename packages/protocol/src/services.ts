/**
 * Ce qu'une entrée représente : un agent ou un terminal (`launcher`), ce qu'il a lancé
 * avec toute sa descendance (`command`), un outil d'agent tel qu'un serveur MCP
 * (`helper`), ou un processus dont le lanceur a disparu, encore tenu par le service
 * systemd de Sillage (`detached`).
 */
export type ServiceKind = 'launcher' | 'command' | 'helper' | 'detached'

export interface ServiceProcessSummary {
  name: string
  count: number
}

/** Processus encore rattachés à l'exécution de Sillage, avec ou sans port. */
export interface ServiceDto {
  id: string
  kind: ServiceKind
  pid: number
  name: string
  /** Ligne de commande abrégée : enrobage du CLI retiré, chemins réduits, secrets masqués. */
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
  projectId: string | null
  projectName: string | null
  conversationId: string | null
  conversationTitle: string | null
  origin: 'agent' | 'terminal' | 'unknown'
  canStop: boolean
}

/**
 * App permanente : une unité systemd utilisateur `sillage-app-*`, créée par un agent
 * pour ce qui doit rester en ligne au-delà d'une session.
 */
export interface ServiceAppDto {
  /** L'unité et son invocation : relancée entre-temps, ce n'est plus la même. */
  id: string
  unit: string
  /** Vide quand systemd l'a déduite de la commande, qu'elle recopierait. */
  description: string
  /** L'exécutable seul, comme le nom d'un processus. */
  executable: string | null
  /** Ligne de commande abrégée, secrets masqués, comme pour un processus. */
  command: string | null
  /** `ActiveState` de systemd. */
  state: 'active' | 'activating' | 'deactivating' | 'reloading' | 'failed' | 'inactive' | (string & {})
  subState: string
  result: string
  mainPid: number | null
  ports: number[]
  cwd: string | null
  startedAt: number | null
  memoryBytes: number | null
  /** Relancée à l'ouverture de la session utilisateur, donc après un redémarrage. */
  enabled: boolean
  transient: boolean
  projectId: string | null
  projectName: string | null
  conversationId: string | null
  conversationTitle: string | null
  origin: 'agent' | 'terminal' | 'unknown'
  canStop: boolean
  canRestart: boolean
  /** Retirer de la liste une app en échec (`reset-failed`). */
  canReset: boolean
}

export type ServiceAppAction = 'stop' | 'restart' | 'reset'

export interface ServicesDto {
  supported: boolean
  scannedAt: number
  services: ServiceDto[]
  apps: ServiceAppDto[]
}
