/** Processus encore rattachés à l'exécution de Sillage, avec ou sans port. */
export interface ServiceDto {
  id: string
  pid: number
  name: string
  parentPid: number
  parentName: string | null
  relation: 'descendant' | 'service-group'
  stopsWithSillage: boolean
  launcher: boolean
  cwd: string | null
  ports: number[]
  startedAt: number
  memoryBytes: number
  projectId: string | null
  projectName: string | null
  conversationId: string | null
  conversationTitle: string | null
  origin: 'agent' | 'terminal' | 'unknown'
  canStop: boolean
}

export interface ServicesDto {
  supported: boolean
  scannedAt: number
  services: ServiceDto[]
}
