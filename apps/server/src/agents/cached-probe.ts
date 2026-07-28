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
}
