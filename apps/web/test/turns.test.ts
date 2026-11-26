import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionMessage } from '@sillage/protocol'
import type { ChatItem, MessageItem } from '@sillage/protocol/chat-state'
import { buildTurns } from '../src/lib/turns'

let seq = 0
function message(role: MessageItem['role'], text: string, extra: Partial<MessageItem> = {}): MessageItem {
  seq += 1
  return {
    kind: 'message',
    id: `m${seq}`,
    role,
    ts: seq,
    seq,
    blocks: text ? [{ type: 'text', text }] : [],
    streamingText: '',
    streamingThinking: '',
    parentToolCallId: null,
    ...extra,
  }
}

test('each user message opens a turn answered by the first main-agent reply', () => {
  const user = message('user', 'Fix   the\nbuild')
  const items: ChatItem[] = [
    user,
    { kind: 'tool', id: 't1' } as ChatItem,
    // Sub-agent text lives in its panel: citing it would point at text absent from the thread.
    message('assistant', 'sub-agent notes', { parentToolCallId: 't1' }),
    message('assistant', 'Done.'),
    message('assistant', 'Also cleaned up.'),
    message('user', 'Thanks'),
  ]
  assert.deepEqual(buildTurns(items), [
    { id: user.id, user: 'Fix the build', assistant: 'Done.' },
    { id: items[5]!.id, user: 'Thanks', assistant: '' },
  ])
})

test('a reply still streaming already describes its turn', () => {
  const turns = buildTurns([message('user', 'Go'), message('assistant', '', { streamingText: 'Working on it' })])
  assert.equal(turns[0]!.assistant, 'Working on it')
})

test('assistant text before any user message opens no turn', () => {
  assert.deepEqual(buildTurns([message('assistant', 'Welcome')]), [])
})

test('long excerpts are cut at 140 characters without a dangling space', () => {
  const [turn] = buildTurns([message('user', `${'a'.repeat(139)} ${'b'.repeat(20)}`)])
  assert.equal(turn!.user, `${'a'.repeat(139)}...`)
  assert.equal(buildTurns([message('user', 'x'.repeat(140))])[0]!.user, 'x'.repeat(140))
})

test('a message from another session is summarized by sender and body, without its envelope', () => {
  const text = formatSessionMessage({ kind: 'message', from: 'c1', title: 'Release', agent: 'claude', messageId: 'id1', body: 'Tag is ready' })
  assert.equal(buildTurns([message('user', text)])[0]!.user, '[Release] Tag is ready')
})
