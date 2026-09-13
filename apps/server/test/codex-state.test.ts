import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from '@sillage/db'
import type { ThreadItem, ThreadTokenUsageUpdatedNotification } from '@sillage/codex-bindings/v2'
import { CodexAsyncQuestions } from '../src/agents/codex/async-questions.js'
import { CodexTurnUsage } from '../src/agents/codex/turn-usage.js'
import { startedItem, completedItem } from '../src/agents/codex/item-events.js'
import { EventLog } from '../src/events/event-log.js'
import { asyncMessage, context, done, itemEvent, runnerFixture } from './codex-support.js'

test('échec de transmission : garder la question répondable, sans résolution optimiste', async () => {
  const f = context()
  const questions = new CodexAsyncQuestions(f.ctx)
  questions.request(asyncMessage, { threadId: 'root' })
  const event = f.events[0]!
  if (event.type !== 'question.requested') throw new Error('Missing question')
  const answer = { status: 'answered' as const, answers: { '0': ['Blue'], '1': ['Nothing'] }, decidedBy: 'test' }
  await assert.rejects(questions.answer(event.requestId, answer, async () => { throw new Error('Transport failed') }), /Transport failed/)
  assert.equal(f.events.length, 1)
  assert.equal(await questions.answer(event.requestId, answer, async () => {}), true)
  assert.equal(f.events[1]!.type, 'question.resolved')
})

test('consommation cumulée, cache et reprise : compter uniquement les nouveaux jetons', () => {
  const usage = new CodexTurnUsage()
  const update = (input: number, output: number, cached: number, turnId = 'turn') => ({
    threadId: 'root', turnId,
    tokenUsage: { modelContextWindow: 100_000,
      total: { inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteInputTokens: 0, totalTokens: input + output, reasoningOutputTokens: 0 },
      last: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 10, cacheWriteInputTokens: 0, totalTokens: 25, reasoningOutputTokens: 0 },
    },
  } satisfies ThreadTokenUsageUpdatedNotification)
  usage.update(update(1000, 100, 900, 'previous'))
  usage.start('turn')
  usage.update(update(1020, 105, 910))
  usage.update(update(1040, 110, 920))
  usage.update(update(1040, 110, 920)) // Snapshot répété.
  assert.deepEqual(usage.finish(), { inputTokens: 20, outputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 0 })
  const resumed = new CodexTurnUsage()
  resumed.start('turn')
  resumed.update(update(1040, 110, 920))
  assert.deepEqual(resumed.finish(), { inputTokens: 10, outputTokens: 5, cacheReadTokens: 10, cacheCreationTokens: 0 })
})

test('le CLI peut omettre turn/started et finir avant sa réponse RPC', async (t) => {
  const f = await runnerFixture(t)
  await f.runner.send(`fixture:${JSON.stringify({ silentStart: true, notifications: [
    itemEvent({ ...asyncMessage, questions: null, text: 'Done' }), done(),
  ] })}`, [], [], [])
  assert.equal(f.events.filter((event) => event.type === 'turn.started').length, 1)
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').length, 1)
  assert.equal(f.statuses.at(-1), 'idle')
})

test('recherche, images, sommeil, compaction et revue ont un rendu normalisé', () => {
  const items = [
    { type: 'webSearch', id: 'web', query: 'Codex', action: { type: 'openPage', url: 'https://developers.openai.com' }, results: [{ title: 'Result' }] },
    { type: 'imageView', id: 'view', path: '/tmp/image.png' },
    { type: 'imageGeneration', id: 'image', status: 'completed', revisedPrompt: 'test', result: 'aGVsbG8=', failure: null },
    { type: 'sleep', id: 'sleep', durationMs: 1000 },
    { type: 'contextCompaction', id: 'compact' },
    { type: 'enteredReviewMode', id: 'review', review: 'Check changes' },
  ] satisfies ThreadItem[]
  const started = items.flatMap((item) => startedItem(item, null))
  const completed = items.flatMap((item) => completedItem(item, '/tmp', 10, null))
  assert.ok(started.some((event) => event.type === 'tool.started' && event.name === 'WebFetch'))
  assert.ok(started.some((event) => event.type === 'context.compaction_started'))
  assert.ok(completed.some((event) => event.type === 'tool.completed' && event.toolCallId === 'web' && JSON.stringify(event.output).includes('Result')))
  assert.ok(completed.some((event) => event.type === 'message.completed' && event.blocks.some((block) => block.type === 'image')))
  assert.ok(completed.some((event) => event.type === 'context.compacted'))
  assert.ok(completed.some((event) => event.type === 'agent.notice' && event.code === 'enteredReviewMode'))
})

test('retrouver les questions asynchrones ouvertes, y compris sur les conversations idle', () => {
  const { db, sqlite } = openDatabase(':memory:')
  try {
    sqlite.exec('CREATE TABLE events (conversation_id TEXT, seq INTEGER, type TEXT, payload TEXT)')
    const insert = sqlite.prepare('INSERT INTO events VALUES (?, ?, ?, ?)')
    for (const id of ['open', 'resolved', 'blocking']) {
      insert.run(id, 1, 'question.requested', JSON.stringify({ requestId: 'same-id', blocking: id === 'blocking' }))
    }
    insert.run('resolved', 2, 'question.resolved', JSON.stringify({ requestId: 'same-id' }))
    assert.deepEqual(new EventLog(db).openAsyncQuestionConversationIds(), ['open'])
  } finally { sqlite.close() }
})
