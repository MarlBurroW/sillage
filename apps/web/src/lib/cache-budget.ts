/** Conservative retained-size estimate, stopping before oversized values incur a full traversal. */
export function retainedBytes(value: unknown, ceiling: number): number {
  let bytes = 0
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length && bytes <= ceiling) {
    const item = pending.pop()
    if (typeof item === 'string') bytes += 24 + item.length * 2
    else if (item && typeof item === 'object') {
      if (seen.has(item)) continue
      seen.add(item)
      bytes += 64
      if (item instanceof Map) {
        bytes += item.size * 48
        for (const [key, value] of item) pending.push(key, value)
      } else {
        const entries = Object.entries(item)
        bytes += entries.length * 16
        for (const [key, value] of entries) { bytes += key.length * 2; pending.push(value) }
      }
    } else bytes += 8
  }
  return bytes
}

export const JOURNAL_CACHE_BYTES = 8 * 1024 * 1024
export const JOURNAL_CACHE_IDLE_MS = 60_000
