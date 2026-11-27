import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recallStep } from '../src/lib/composer-history'
import { messageHistory } from '../src/lib/turns'
import type { ChatItem } from '../src/lib/chat-fold'

const history = ['first', 'second\nline two', 'third']
const at = (text: string, caret = text.length) => ({ history, text, caretStart: caret, caretEnd: caret })

test('↑ from an empty field recalls the newest message, then older ones', () => {
  const one = recallStep('ArrowUp', { ...at(''), recall: null })
  assert.deepEqual(one, { recall: 2, text: 'third' })
  const two = recallStep('ArrowUp', { ...at('third'), recall: 2 })
  assert.deepEqual(two, { recall: 1, text: 'second\nline two' })
})

test('↑ never replaces writing, and an edited recall ends browsing', () => {
  assert.equal(recallStep('ArrowUp', { ...at('draft'), recall: null }), null)
  assert.equal(recallStep('ArrowUp', { ...at('third!'), recall: 2 }), null)
  assert.equal(recallStep('ArrowDown', { ...at('third!'), recall: 2 }), null)
})

test('inside a multi-line recall the arrows move the caret until the edge line', () => {
  const text = 'second\nline two'
  assert.equal(recallStep('ArrowUp', { ...at(text), recall: 1 }), null, 'caret on the last line: move up within')
  assert.deepEqual(recallStep('ArrowUp', { ...at(text, 3), recall: 1 }), { recall: 0, text: 'first' })
  assert.equal(recallStep('ArrowDown', { ...at(text, 3), recall: 1 }), null, 'caret on the first line: move down within')
  assert.deepEqual(recallStep('ArrowDown', { ...at(text), recall: 1 }), { recall: 2, text: 'third' })
})

test('↓ past the newest message gives the empty field back; ↑ at the oldest stays', () => {
  assert.deepEqual(recallStep('ArrowDown', { ...at('third'), recall: 2 }), { recall: null, text: '' })
  assert.deepEqual(recallStep('ArrowUp', { ...at('first'), recall: 0 }), { recall: 0, text: 'first' })
  assert.equal(recallStep('ArrowDown', { ...at(''), recall: null }), null)
  assert.equal(recallStep('ArrowUp', { history: [], text: '', caretStart: 0, caretEnd: 0, recall: null }), null)
})

test('history keeps the user’s own words: no peer messages, no sub-agent prompts, no repeats', () => {
  const message = (id: string, text: string, extra: Partial<ChatItem> = {}): ChatItem => ({
    kind: 'message', id, role: 'user', ts: 0, seq: 0, blocks: [{ type: 'text', text }],
    streamingText: '', streamingThinking: '', parentToolCallId: null, ...extra,
  } as ChatItem)
  const items: ChatItem[] = [
    message('a', 'fix the build'),
    message('b', 'fix the build'),
    message('c', 'explore the repo', { parentToolCallId: 'tool-1' } as Partial<ChatItem>),
    { ...message('d', 'done'), role: 'assistant' } as ChatItem,
    message('e', 'and the tests'),
  ]
  assert.deepEqual(messageHistory(items, [{ text: 'queued one' }]), ['fix the build', 'and the tests', 'queued one'])
})
