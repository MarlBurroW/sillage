import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 256 * 1024
const MAX_RECORDS = 300
export const DIAGNOSTIC_STAGES = ['startup', 'memory', 'memory-unavailable', 'server-exit', 'unresponsive', 'responsive', 'renderer-exit', 'child-exit', 'thread-open', 'thread-ready', 'thread-history', 'thread-visible', 'thread-error', 'renderer-sample'] as const
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number]
const METRICS = new Set(['ms', 'items', 'bytes', 'cursor', 'cached', 'heapBytes', 'rssBytes', 'mainRssBytes', 'rendererRssBytes', 'gpuRssBytes', 'otherRssBytes', 'serverRssBytes', 'serverHeapBytes', 'cliAndToolsRssBytes', 'cliAndToolsCount', 'exitCode', 'oom', 'longTasks', 'longTaskMs', 'cacheBytes', 'cacheEntries'])
interface RecordEntry { at: string; stage: DiagnosticStage; metrics: Record<string, number> }

/** Whitelist at the trust boundary; even renderer IPC and old files cannot add user content. */
export function diagnosticRecord(stage: unknown, metrics: unknown): RecordEntry | null {
  if (!DIAGNOSTIC_STAGES.includes(stage as DiagnosticStage)) return null
  const clean: Record<string, number> = {}
  if (metrics && typeof metrics === 'object') for (const [key, value] of Object.entries(metrics)) {
    if (METRICS.has(key) && typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) clean[key] = value
  }
  return { at: new Date().toISOString(), stage: stage as DiagnosticStage, metrics: clean }
}

export class DiagnosticLog {
  private records: RecordEntry[] = []
  constructor(private file: string) {
    for (const name of [`${file}.1`, file]) {
      try {
        if (statSync(name).size > MAX_BYTES + 4096) continue
        for (const line of readFileSync(name, 'utf8').split('\n')) {
          try {
            const value = JSON.parse(line) as RecordEntry
            const clean = diagnosticRecord(value.stage, value.metrics)
            if (clean && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.at)) this.records.push({ ...clean, at: value.at })
          } catch { /* A partial last line after a crash is disposable. */ }
        }
      } catch { /* First run or unavailable diagnostics directory. */ }
    }
    this.records = this.records.slice(-MAX_RECORDS)
  }
  add(stage: DiagnosticStage, metrics: unknown = {}): void {
    const record = diagnosticRecord(stage, metrics)
    if (!record) return
    this.records.push(record)
    if (this.records.length > MAX_RECORDS) this.records.shift()
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      try { if (statSync(this.file).size >= MAX_BYTES) renameSync(this.file, `${this.file}.1`) } catch { /* No previous file. */ }
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    } catch { /* Diagnostics must never prevent the app from running. */ }
  }
  snapshot(): RecordEntry[] { return this.records.map((row) => ({ ...row, metrics: { ...row.metrics } })) }
}
