import { Worker } from 'node:worker_threads'
import type { ExportField, ExportFinding, ExportRenderRequest, RedactionKind } from '@sillage/protocol'
import { badRequest } from '../http/errors.js'

/** Rules run outside the HTTP event loop; cancellation also stops pathological input. */
export function scanFields(fields: ExportField[], signal: AbortSignal, progress: (value: number) => void): Promise<ExportFinding[]> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './scan-worker.mjs' : './exports/scan-worker.mjs', import.meta.url), {
      workerData: fields.map(({ id, text }) => ({ id, text })), execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 384 },
    })
    let done = false
    const finish = (findings?: ExportFinding[]) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      void worker.terminate()
      if (findings) resolve(findings)
      else reject(badRequest('export_scan_failed', 'Private information could not be checked.'))
    }
    const cancel = () => finish()
    const timeout = setTimeout(cancel, 120_000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.on('message', (message: { progress?: number; findings?: ExportFinding[]; failed?: boolean }) => {
      if (message.progress !== undefined) progress(message.progress)
      if (message.findings) finish(message.findings)
      if (message.failed) finish()
    })
    worker.once('error', () => finish())
    worker.once('exit', () => { if (!done) finish() })
  })
}

export function maskFields(fields: ExportField[], findings: ExportFinding[], request: ExportRenderRequest,
  label: (kind: RedactionKind | 'manual') => string): Map<string, string> {
  const known = new Set(findings.map(finding => finding.id))
  if (request.kept.some(id => !known.has(id))) throw badRequest('export_invalid', 'Invalid redaction.')
  const byId = new Map(fields.map(field => [field.id, field]))
  for (const mask of request.manual) {
    const field = byId.get(mask.fieldId)
    if (!field || mask.end <= mask.start || mask.end > field.text.length) throw badRequest('export_invalid', 'Invalid redaction.')
  }
  const kept = new Set(request.kept)
  const masked = new Map<string, string>()
  for (const field of fields) {
    const ranges: { start: number; end: number; kind: RedactionKind | 'manual' }[] = [
      ...findings.filter(f => f.fieldId === field.id && !kept.has(f.id)),
      ...request.manual.filter(f => f.fieldId === field.id).map(f => ({ ...f, kind: 'manual' as const })),
    ].sort((a, b) => a.start - b.start || b.end - a.end)
    const merged: typeof ranges = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous && range.start < previous.end) {
        previous.end = Math.max(previous.end, range.end)
        if (range.kind === 'secret') previous.kind = 'secret'
      } else merged.push({ ...range })
    }
    let cursor = 0, text = ''
    for (const range of merged) {
      text += field.text.slice(cursor, range.start) + label(range.kind)
      cursor = range.end
    }
    masked.set(field.id, text + field.text.slice(cursor))
  }
  return masked
}
