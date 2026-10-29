import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExportField, ExportFinding } from '@sillage/protocol'
import { maskedExcerpt, phraseMasks, reconcileReview } from '../../web/src/lib/export-review.js'

test('manual phrases use literal UTF-16 positions and skip already masked occurrences', () => {
  const fields: ExportField[] = [{ id: 'a', entryId: null, kind: 'message', text: '🛟 A.* A.* a.*' }]
  const masks = phraseMasks(fields, 'A.*', [])
  assert.deepEqual(masks, [{ fieldId: 'a', start: 3, end: 6 }, { fieldId: 'a', start: 7, end: 10 }])
  assert.equal(fields[0]!.text.slice(masks[0]!.start, masks[0]!.end), 'A.*')
  assert.deepEqual(phraseMasks(fields, 'A.*', masks), [])
  assert.deepEqual(phraseMasks(fields, ' ', []), [])
  assert.deepEqual(phraseMasks(fields, 'missing', []), [])
  assert.equal(phraseMasks([{ ...fields[0]!, text: 'a'.repeat(20_000) }], 'a', []).length, 10_001, 'bounded even for repeated single-character phrases')
})

test('review decisions survive only when the whole source field is unchanged', () => {
  const fields: ExportField[] = [
    { id: 'a', entryId: null, kind: 'introduction', text: 'public@example.test' },
    { id: 'b', entryId: '2', kind: 'message', text: 'private@example.test' },
    { id: 'c', entryId: '3', kind: 'message', text: 'removed@example.test' },
  ]
  const findings: ExportFinding[] = fields.map(field => ({ id: field.id, fieldId: field.id, start: 0, end: field.text.length, kind: 'email', group: 'old-' + field.id }))
  const updated = [fields[0]!, { ...fields[1]!, text: 'changed@example.test' }]
  const rescanned = findings.slice(0, 2).map(finding => ({ ...finding, id: 'new-' + finding.id, group: 'new-' + finding.group }))
  const result = reconcileReview({ fields, findings, kept: ['a', 'b', 'c'], manual: findings.map(({ fieldId, start, end }) => ({ fieldId, start, end })) }, updated, rescanned)
  assert.deepEqual(result.kept, ['new-a'])
  assert.deepEqual(result.manual, [{ fieldId: 'a', start: 0, end: fields[0]!.text.length }])
})

test('review excerpts conceal overlapping findings and manual masks before truncation', () => {
  const field: ExportField = { id: 'a', entryId: null, kind: 'message', text: 'Before TOP-SECRET after CODE-123 and ending' }
  const finding: ExportFinding = { id: '1', fieldId: 'a', start: 7, end: 17, kind: 'secret', group: '1' }
  const excerpt = maskedExcerpt(field, [finding, { ...finding, id: '2', start: 11 }], [{ fieldId: 'a', start: 24, end: 32 }], '[masked]')
  assert.equal(excerpt, 'Before [masked] after [masked] and ending')
  assert.ok(!maskedExcerpt(field, [finding], [], '[masked]', 12).includes('TOP'))
})
