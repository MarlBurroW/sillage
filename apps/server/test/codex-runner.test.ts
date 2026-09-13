import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sillageEventSchema } from '@sillage/protocol'
import { runnerFixture, asyncMessage, done, itemEvent } from './codex-support.js'

test('questions Astra interactives, non bloquantes et encore répondables après la fin du tour', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([itemEvent(asyncMessage), done()])
  const question = f.events.find((event) => event.type === 'question.requested')!
  assert.equal(question.type, 'question.requested')
  if (question.type !== 'question.requested') return
  assert.equal(question.blocking, false)
  assert.deepEqual(question.questions[0]!.options.map((option) => option.label), ['Blue', 'Green'])
  assert.equal(question.questions[1]!.allowOther, true)
  assert.equal(f.statuses.at(-1), 'idle') // La réponse RPC tardive ne réactive pas un tour fini.
  assert.ok(!f.statuses.includes('awaiting_input'))
  assert.ok(!f.events.some((event) => event.type === 'question.resolved'))
  const answer = { status: 'answered' as const, answers: { '0': ['Green'], '1': ['Keep it simple'] }, decidedBy: 'test' }
  assert.equal(await f.runner.answerQuestion(question.requestId, answer), true)
  assert.equal(await f.runner.answerQuestion(question.requestId, answer), false)
  const turns = (await f.records()).filter((record) => record.method === 'turn/start')
  assert.equal(turns.length, 2)
  assert.equal(turns[1].params.clientUserMessageId, question.requestId)
  assert.match(turns[1].params.input[0].text, /Which color\?\nGreen/)
  assert.ok(f.events.some((event) => event.type === 'question.resolved' && event.status === 'answered'))
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('questions concurrentes et serverRequest/resolved ciblé avec ids natifs distincts', async (t) => {
  const f = await runnerFixture(t)
  const request = (id: number | string, isBlocking: boolean) => ({ id, method: 'item/tool/requestUserInput', params: {
    threadId: 'root', turnId: 'turn-1', itemId: String(id), isBlocking, autoResolutionMs: 1,
    questions: [{ id: 'q', header: 'Question', question: String(id), isOther: false, isSecret: false, options: [] }],
  } })
  await f.emit([], [request(0, true), request('second', true), request('optional', false)])
  const questions = f.events.filter((event) => event.type === 'question.requested')
  assert.equal(questions.length, 3)
  assert.equal(questions[0]!.questions[0]!.allowOther, true)
  assert.equal(await f.runner.answerQuestion(questions[0]!.requestId, { status: 'answered', answers: { q: ['yes'] }, decidedBy: 'test' }), true)
  assert.equal(f.statuses.at(-1), 'awaiting_input')
  await f.emit([{ method: 'serverRequest/resolved', params: { threadId: 'root', requestId: 'second' } }])
  assert.equal(f.statuses.at(-1), 'running')
  assert.equal(f.events.filter((event) => event.type === 'question.resolved' && event.status === 'expired').length, 1)
  assert.equal(await f.runner.answerQuestion(questions[1]!.requestId, { status: 'cancelled', answers: {}, decidedBy: 'test' }), false)
  assert.equal(await f.runner.answerQuestion(questions[2]!.requestId, { status: 'answered', answers: { q: ['optional answer'] }, decidedBy: 'test' }), true)
  await f.emit() // Barrière transport.
  const replies = (await f.records()).filter((record) => record.result)
  assert.ok(replies.some((record) => record.id === 0 && record.result.answers.q.answers[0] === 'yes'))
  assert.ok(!replies.some((record) => record.id === 'second'))
})

test('sauter une question asynchrone ne choisit ni ne relance de tour', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([itemEvent(asyncMessage), done()])
  const question = f.events.find((event) => event.type === 'question.requested')!
  assert.equal(question.type, 'question.requested')
  if (question.type !== 'question.requested') return
  assert.equal(await f.runner.answerQuestion(question.requestId, { status: 'cancelled', answers: {}, decidedBy: 'test' }), true)
  assert.equal(f.statuses.at(-1), 'idle')
  assert.equal((await f.records()).filter((record) => record.method === 'turn/start').length, 1)
})

test('plans, outils récents, événements inconnus et clôtures orphelines restent visibles', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([
    { method: 'turn/plan/updated', params: { threadId: 'root', turnId: 'turn-1', explanation: null, plan: [{ step: 'Inspect the CLI', status: 'inProgress' }] } },
    { method: 'item/plan/delta', params: { threadId: 'root', itemId: 'plan', delta: 'Draft' } },
    itemEvent({ type: 'plan', id: 'plan', text: 'Final plan' }),
    itemEvent({ type: 'dynamicToolCall', id: 'dynamic', namespace: 'functions', tool: 'exec', arguments: { code: '1 + 1' }, status: 'completed', contentItems: [{ type: 'inputText', text: '2' }], success: true, durationMs: 3 }),
    itemEvent({ type: 'futureTool', id: 'future', result: 'preserved' }),
    { method: 'future/progress', params: { threadId: 'root', result: 'preserved' } },
    { method: 'future/progress', params: { threadId: 'root', result: 'again' } },
    done(), done(),
  ])
  const plan = f.events.find((event) => event.type === 'plan.updated')!
  assert.deepEqual(plan, { type: 'plan.updated', items: [{ text: 'Inspect the CLI', status: 'in_progress' }] })
  assert.ok(f.events.some((event) => event.type === 'tool.started' && event.name === 'functions/exec'))
  assert.ok(f.events.some((event) => event.type === 'tool.started' && event.name === 'Codex/futureTool'))
  const notices = f.events.filter((event) => event.type === 'agent.notice' && event.code === 'future/progress')
  assert.equal(notices.length, 2)
  assert.equal(notices[0]!.id, notices[1]!.id)
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').length, 1)
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('la fin d’un sous-agent ne termine pas le tour principal', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([
    { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', agentNickname: 'Inspector', preview: 'Inspect' } } },
    itemEvent({ ...asyncMessage, id: 'child-message', questions: null, text: 'Child result' }, 'item/completed', 'child'),
    done('child-turn', 'child'),
  ])
  assert.equal(f.statuses.at(-1), 'running')
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').length, 0)
  const agent = f.events.find((event) => event.type === 'tool.started' && event.name === 'Agent')!
  const message = f.events.find((event) => event.type === 'message.completed' && event.messageId === 'child-message')!
  assert.ok(agent.type === 'tool.started' && message.type === 'message.completed' && message.parentToolCallId === agent.toolCallId)
})

test('la fin du parent ne supprime pas une question encore attendue par son sous-agent', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([
    { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', agentNickname: 'Inspector', preview: 'Inspect' } } },
  ], [{ id: 'child-question', method: 'item/tool/requestUserInput', params: {
    threadId: 'child', turnId: 'child-turn', itemId: 'question', isBlocking: true, autoResolutionMs: null,
    questions: [{ id: 'q', header: '', question: 'Choice?', isOther: true, isSecret: false, options: null }],
  } }])
  const question = f.events.find((event) => event.type === 'question.requested')!
  if (question.type !== 'question.requested') throw new Error('Missing question')
  await f.emit([done()])
  assert.equal(f.statuses.at(-1), 'awaiting_input')
  assert.ok(!f.events.some((event) => event.type === 'question.resolved'))
  assert.equal(await f.runner.answerQuestion(question.requestId, { status: 'answered', answers: { q: ['Continue'] }, decidedBy: 'test' }), true)
})
