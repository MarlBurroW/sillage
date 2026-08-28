/**
 * Cache d'une sonde coûteuse, avec une seule lecture en vol.
 *
 * Toutes les sondes d'agent démarrent un process CLI : dix requêtes simultanées ne
 * doivent pas lancer dix CLI, et une valeur fraîche n'a pas à être relue. Ce
 * squelette était recopié dans chaque catalogue et lecteur de quota.
 */
export class CachedProbe<T extends object> {
  private cache: (T & { fetchedAt: number }) | null = null
  private inflight: Promise<T> | null = null

  constructor(
    private readonly ttlMs: number,
    private readonly probe: () => Promise<T>,
  ) {}

  async read(force = false): Promise<T & { fetchedAt: number }> {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < this.ttlMs) {
      return this.cache
    }

    this.inflight ??= this.probe().finally(() => {
      this.inflight = null
    })

    this.cache = { ...(await this.inflight), fetchedAt: Date.now() }
    return this.cache
  }

  /** Périmée et sans lecture en vol : plus rien à garder. */
  expired(ttlMs: number): boolean {
    if (this.inflight !== null) return false
    return this.cache === null || Date.now() - this.cache.fetchedAt >= ttlMs
  }
}

/**
 * Même chose, une sonde par clé : pour ce qui dépend d'un dossier plutôt que du daemon.
 *
 * Les entrées périmées sont retirées au passage plutôt que gardées à vie : les
 * worktrees naissent et disparaissent, et rien d'autre ne viendrait purger la carte.
 * La clé passe par `normalize` pour que deux écritures du même dossier (barre finale,
 * segment `..`) partagent une sonde au lieu d'en lancer deux.
 */
export class CachedProbeMap<T extends object> {
  private readonly probes = new Map<string, CachedProbe<T>>()

  constructor(
    private readonly ttlMs: number,
    private readonly probe: (key: string) => Promise<T>,
    private readonly normalize: (key: string) => string = (key) => key,
  ) {}

  read(key: string, force = false): Promise<T & { fetchedAt: number }> {
    this.prune()
    const normalized = this.normalize(key)
    let probe = this.probes.get(normalized)
    if (!probe) {
      probe = new CachedProbe(this.ttlMs, () => this.probe(normalized))
      this.probes.set(normalized, probe)
    }
    return probe.read(force)
  }

  private prune(): void {
    for (const [key, probe] of this.probes) {
      if (probe.expired(this.ttlMs)) this.probes.delete(key)
    }
  }
}
