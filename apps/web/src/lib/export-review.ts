import type { ExportField, ExportFinding, ExportRenderRequest } from '@sillage/protocol'

type Manual = ExportRenderRequest['manual']

/** Match literal text at UTF-16 offsets, the same units used by text selections and rendering. */
export function phraseMasks(fields: ExportField[], phrase: string, existing: Manual): Manual {
  if (!phrase.trim()) return []
  const masks: Manual = []
  for (const field of fields) {
    let start = field.text.indexOf(phrase)
    while (start !== -1 && masks.length <= 10_000) {
      const end = start + phrase.length
      if (!existing.some(mask => mask.fieldId === field.id && mask.start <= start && mask.end >= end)) {
        masks.push({ fieldId: field.id, start, end })
      }
      start = field.text.indexOf(phrase, end)
    }
    if (masks.length > 10_000) break
  }
  return masks
}

/** Only retain decisions where the underlying text is unchanged after a new analysis. */
export function reconcileReview(previous: { fields: ExportField[]; findings: ExportFinding[]; kept: string[]; manual: Manual },
  fields: ExportField[], findings: ExportFinding[]) {
  const oldFields = new Map(previous.fields.map(field => [field.id, field.text]))
  const unchanged = new Set(fields.filter(field => oldFields.get(field.id) === field.text).map(field => field.id))
  const kept = new Set(previous.kept)
  const signature = (finding: ExportFinding) => JSON.stringify([finding.fieldId, finding.start, finding.end, finding.kind])
  const allowed = new Set(previous.findings.filter(finding => kept.has(finding.id) && unchanged.has(finding.fieldId)).map(signature))
  return {
    kept: findings.filter(finding => allowed.has(signature(finding))).map(finding => finding.id),
    manual: previous.manual.filter(mask => unchanged.has(mask.fieldId)),
  }
}

/** A private review heading must not accidentally reveal values hidden in its findings. */
export function maskedExcerpt(field: ExportField, findings: ExportFinding[], manual: Manual, replacement: string, limit = 130): string {
  const ranges = [...findings.filter(finding => finding.fieldId === field.id), ...manual.filter(mask => mask.fieldId === field.id)]
    .sort((a, b) => a.start - b.start || b.end - a.end)
  let cursor = 0, result = ''
  for (const range of ranges) {
    if (range.end <= cursor) continue
    result += field.text.slice(cursor, Math.max(cursor, range.start)) + replacement
    cursor = range.end
    if (result.length > limit) break
  }
  if (result.length <= limit) result += field.text.slice(cursor, cursor + limit + 1)
  const excerpt = result.replace(/\s+/g, ' ').trim()
  return excerpt.slice(0, limit) + (excerpt.length > limit ? '…' : '')
}
