import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDatabase } from '@sillage/db'
import type { ThreadItem, ThreadTokenUsageUpdatedNotification } from '@sillage/codex-bindings/v2'
import { CodexAsyncQuestions } from '../src/agents/codex/async-questions.js'
import { CodexTurnUsage } from '../src/agents/codex/turn-usage.js'
import { startedItem, completedItem } from '../src/agents/codex/item-events.js'
import { EventLog } from '../src/events/event-log.js'
import { codexErrorCode } from '../src/agents/codex/errors.js'
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
  usage.update(update(1040, 110, 920)) // Repeated snapshot.
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
    { type: 'imageGeneration', id: 'image', status: 'completed', revisedPrompt: 'test', result: 'aGVsbG8=', failure: null, generationId: null },
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
  // Missing images yield paths only, never errors.
  assert.ok(completed.some((event) => event.type === 'tool.completed' && event.toolCallId === 'view' && JSON.stringify(event.output) === '{"path":"/tmp/image.png"}'))
  assert.ok(completed.some((event) => event.type === 'context.compacted'))
  assert.ok(completed.some((event) => event.type === 'agent.notice' && event.code === 'enteredReviewMode'))
})

test('generated image file IDs use the saved file without inventing a remote URL', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sillage-generated-image-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  writeFileSync(join(cwd, 'generated.png'), png)
  const item: ThreadItem = {
    type: 'imageGeneration', id: 'generated', status: 'completed', revisedPrompt: 'fixture',
    generationId: 'generation', fileId: 'remote-file', savedPath: join(cwd, 'generated.png'), failure: null,
  }
  const events = completedItem(item, cwd, 10, 'parent')
  const image = events.find((event) => event.type === 'message.completed')
  assert.deepEqual(image, {
    type: 'message.completed', messageId: 'image-generated', role: 'assistant', parentToolCallId: 'parent',
    blocks: [{ type: 'image', mimeType: 'image/png', url: `data:image/png;base64,${png.toString('base64')}` }],
  })
  for (const savedPath of [join(cwd, 'missing.png'), join(cwd, 'large.png')]) {
    if (savedPath.endsWith('large.png')) writeFileSync(savedPath, Buffer.alloc(4 * 1024 * 1024 + 1))
    const unavailable = completedItem({ ...item, savedPath }, cwd, 10, null)
    assert.equal(unavailable.some((event) => event.type === 'message.completed'), false)
    const tool = unavailable.find((event) => event.type === 'tool.completed')
    assert.equal((tool as { output: { savedPath: string } }).output.savedPath, savedPath)
  }
})

test('new Codex terminal errors keep stable translated codes', () => {
  assert.equal(codexErrorCode('modelNotFound'), 'model_not_found')
  assert.equal(codexErrorCode('policyCapacityUnavailable'), 'policy_capacity_unavailable')
  assert.equal(codexErrorCode('inferenceHookDenied'), 'inference_hook_denied')
})

test('une image vue par Codex est jointe en base64, dans la forme du Read de Claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-view-'))
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  writeFileSync(join(dir, 'shot.png'), png)
  const completed = completedItem({ type: 'imageView', id: 'view', path: 'shot.png' }, dir, 10, null)
  const event = completed.find(event => event.type === 'tool.completed')
  assert.equal(event!.type, 'tool.completed')
  assert.deepEqual((event as { output: unknown }).output, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    { type: 'text', text: 'shot.png' },
  ])
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
