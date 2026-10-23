let observing = false

/** The optional Desktop bridge accepts only named numeric measurements, never session content. */
export function recordPerformance(stage: string, metrics: Record<string, number> = {}): void {
  const diagnostics = window.sillageDesktop?.diagnostics
  if (!diagnostics) return
  diagnostics.record(stage, metrics)
  if (observing) return
  observing = true
  let longTasks = 0, longTaskMs = 0
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) { longTasks++; longTaskMs += entry.duration }
    })
    observer.observe({ type: 'longtask' })
  }
  window.setInterval(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    diagnostics.record('renderer-sample', { longTasks, longTaskMs, ...(memory ? { heapBytes: memory.usedJSHeapSize } : {}) })
    longTasks = 0; longTaskMs = 0
  }, 30_000)
}
