import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noticeText, type NoticeItem } from '../src/lib/chat-fold'

const notice = (code: string, text: string, details?: unknown): NoticeItem =>
  ({ kind: 'notice', id: code, ts: 0, code, text, level: 'info', details }) as NoticeItem

// The runner used to write these in French, so an English interface showed French lines.
test('Codex notices written by Sillage follow the interface language', () => {
  assert.equal(noticeText(notice('codex_retry', 'x', { message: 'stream closed' })), 'Codex is retrying after an interruption: stream closed')
  assert.equal(noticeText(notice('codex_retry', 'x', { agent: 'Euclid', message: 'Reconnecting... 1/5' })),
    'Euclid is retrying after an interruption: Reconnecting... 1/5')
  assert.equal(noticeText(notice('codex_model_rerouted', 'x', { fromModel: 'a', toModel: 'b' })), 'Codex uses b instead of a.')
  assert.equal(noticeText(notice('codex_event', 'x', { method: 'future/progress', params: {} })), 'Codex event: future/progress')
  assert.equal(noticeText(notice('enteredReviewMode', 'Codex démarre une revue.')), 'Codex starts a review.')
})

test('texts that come from Codex itself are shown as sent', () => {
  assert.equal(noticeText(notice('codex_subagent_error', "Euclid: You've hit your usage limit.", { agent: 'Euclid', message: "You've hit your usage limit." })),
    "Euclid: You've hit your usage limit.")
  assert.equal(noticeText(notice('codex_auto_review_denied', 'Too risky', { rationale: 'Too risky', action: {} })), 'Too risky')
  assert.equal(noticeText(notice('codex_auto_review_denied', 'x', { rationale: null, action: {} })), 'Automatic review denied this action.')
})
