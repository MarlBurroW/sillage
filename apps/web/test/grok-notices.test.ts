import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noticeText, type NoticeItem } from '../src/lib/chat-fold'

const notice = (code: string, text: string, details?: unknown): NoticeItem =>
  ({ kind: 'notice', id: code, ts: 0, code, text, level: 'warning', details }) as NoticeItem

test('Grok model and effort fallbacks follow the interface language', () => {
  assert.equal(noticeText(notice('grok_model_unavailable', 'x', { requested: 'grok-4.1', model: 'grok-4.7' })),
    'Grok no longer offers grok-4.1 to this account: the session continues on grok-4.7, shown in the composer.')
  assert.equal(noticeText(notice('grok_effort_unavailable', 'x', { requested: 'xhigh', model: 'grok-4.5', effort: 'low' })),
    'grok-4.5 does not offer the xhigh effort: the session continues on low, shown in the composer.')
  // Without the values the runner names (no current model or effort), its own sentence stays.
  assert.equal(noticeText(notice('grok_effort_unavailable', 'kept as sent', { requested: 'xhigh', model: 'grok-4.5', effort: null })), 'kept as sent')
})
