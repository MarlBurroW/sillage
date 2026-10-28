/**
 * Expensive-probe cache with one read in flight.
 *
 * Every agent probe starts CLI: ten simultaneous requests must not launch ten CLIs, fresh values
 * need no reread. Skeleton previously duplicated across catalogs/quota readers.
 */
export class CachedProbe<T extends object> {
  private cache: (T & { fetchedAt: number }) | null = null
  private inflight: Promise<T> | null = null
  private revision = 0

  constructor(
    private readonly ttlMs: number,
    private readonly probe: () => Promise<T>,
  ) {}

  async read(force = false): Promise<T & { fetchedAt: number }> {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < this.ttlMs) {
      return this.cache
    }

    const revision = this.revision
    if (!this.inflight) {
      const pending = this.probe().finally(() => {
        if (this.inflight === pending) this.inflight = null
      })
      this.inflight = pending
    }
    const result = { ...(await this.inflight), fetchedAt: Date.now() }
    if (revision === this.revision) this.cache = result
    return result
  }

  /** Forget value: next read probes regardless of TTL. */
  invalidate(): void {
    this.cache = null
    this.inflight = null
    this.revision++
  }

  /** Expired without in-flight read: nothing to keep. */
  expired(ttlMs: number): boolean {
    if (this.inflight !== null) return false
    return this.cache === null || Date.now() - this.cache.fetchedAt >= ttlMs
  }
}

/**
 * Same per key for directory-dependent probes.
 *
 * Remove expired entries while traversing: worktrees appear/disappear and nothing else purges map.
 * normalize makes alternate directory spellings (trailing slash, ..) share one probe.
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

  invalidate(): void {
    this.probes.clear()
  }

  private prune(): void {
    for (const [key, probe] of this.probes) {
      if (probe.expired(this.ttlMs)) this.probes.delete(key)
    }
  }
}
