import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CODEX_CONFIG, sillageEventSchema } from '@sillage/protocol'
import { CodexRunner } from '../src/agents/codex/runner.js'
import { runnerFixture, asyncMessage, context, done, fixture, itemEvent } from './codex-support.js'

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

test('un message à un sous-agent terminé ne le remet pas en cours, un nouveau tour si', async (t) => {
  const f = await runnerFixture(t)
  const interacted = (id: string, agentThreadId: string, agentPath: string) =>
    itemEvent({ type: 'subAgentActivity', id, kind: 'interacted', agentThreadId, agentPath })
  const running = () => f.events.filter((event) => event.type === 'background.updated').at(-1)
  await f.emit([
    { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', agentNickname: 'Inspector', preview: 'Inspect' } } },
    done('child-turn', 'child'),
    // Le parent écrit au sous-agent terminé, et le sous-agent avait écrit à `/root`.
    interacted('to-child', 'child', '/root/inspector'),
    interacted('to-root', 'root', '/root'),
  ])
  assert.deepEqual(running(), { type: 'background.updated', tasks: [] })
  assert.equal(f.events.filter((event) => event.type === 'task.started').length, 1)

  // Le message relance un tour du sous-agent : lui seul le remet en cours, jusqu'à sa fin.
  await f.emit([{ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn-2' } } }])
  assert.deepEqual(running(), { type: 'background.updated', tasks: [{ id: 'child', kind: 'agent', description: 'Inspector' }] })
  await f.emit([done('child-turn-2', 'child')])
  assert.deepEqual(running(), { type: 'background.updated', tasks: [] })
  for (const event of f.events) sillageEventSchema.parse(event)
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

test('bibliothèque de skills : posée avant le thread, remplacée à chaud, absente si coupée', async (t) => {
  const transport = await fixture(t)
  const roots = ['/library/global', '/library/projects/p1']
  const state = context({ ...transport, skillRoots: (config) => (config.skillLibrary ? roots : []) })
  const runner = new CodexRunner(state.ctx)
  transport.onClose(() => runner.stop())
  await runner.start()

  const calls = async () => (await transport.records()).filter((record) => record.method === 'skills/extraRoots/set')
  const methods = (await transport.records()).map((record) => record.method)
  const set = methods.indexOf('skills/extraRoots/set')
  // La racine appartient au process, pas au thread : elle doit précéder `thread/start`.
  assert.ok(set > methods.indexOf('initialized') && set < methods.indexOf('thread/start'))
  assert.deepEqual((await calls())[0].params.extraRoots, ['/library/global/skills', '/library/projects/p1/skills'])

  assert.equal(await runner.applyConfig({ ...DEFAULT_CODEX_CONFIG, skillLibrary: true }), true)
  assert.equal((await calls()).length, 1, 'mêmes racines, rien à renvoyer')
  // Recharger repose les racines : l'app-server ne voit pas seul un dossier qui part.
  await runner.reloadSkillLibrary()
  assert.equal((await calls()).length, 2)
  assert.deepEqual((await calls())[1].params.extraRoots, (await calls())[0].params.extraRoots)
  assert.equal(await runner.applyConfig({ ...DEFAULT_CODEX_CONFIG, skillLibrary: false }), true)
  assert.deepEqual((await calls()).at(-1).params.extraRoots, [])
  await runner.reloadSkillLibrary()
  assert.equal((await calls()).length, 3, 'bibliothèque coupée, rien à recharger')

  const off = await fixture(t)
  const quiet = new CodexRunner(context({ ...off, config: { ...DEFAULT_CODEX_CONFIG, skillLibrary: false }, skillRoots: () => [] }).ctx)
  off.onClose(() => quiet.stop())
  await quiet.start()
  assert.ok(!(await off.records()).some((record) => record.method === 'skills/extraRoots/set'))
})

test('Codex 0.163 : état de lecture ignoré et sorties des outils concurrents associées par id', async (t) => {
  const f = await runnerFixture(t)
  const command = (id: string) => ({ type: 'commandExecution', id, command: `cat ${id}`, cwd: '/tmp',
    status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null })
  await f.emit([
    { method: 'thread/readState/changed', params: { threadId: 'root', readState: { firstUnread: null, revision: '1' } } },
    itemEvent(command('first'), 'item/started'),
    itemEvent(command('second'), 'item/started'),
    { method: 'item/commandExecution/outputDelta', params: { threadId: 'root', turnId: 'turn-1', itemId: 'second', delta: 'B' } },
    { method: 'item/commandExecution/outputDelta', params: { threadId: 'root', turnId: 'turn-1', itemId: 'first', delta: 'A' } },
    itemEvent({ ...command('second'), status: 'completed', aggregatedOutput: 'B', exitCode: 0 }),
    itemEvent({ ...command('first'), status: 'completed', aggregatedOutput: 'A', exitCode: 0 }),
    done(),
  ])
  assert.deepEqual(f.events.filter((event) => event.type === 'tool.started').map((event) => event.toolCallId), ['first', 'second'])
  assert.deepEqual(f.events.filter((event) => event.type === 'tool.output_delta').map((event) => [event.toolCallId, event.chunk]), [['second', 'B'], ['first', 'A']])
  assert.deepEqual(f.events.filter((event) => event.type === 'tool.completed').map((event) => [event.toolCallId, event.output]), [['second', 'B'], ['first', 'A']])
  assert.ok(!f.events.some((event) => event.type === 'agent.notice' || event.type === 'error'))
  assert.equal(f.statuses.at(-1), 'idle')
})

/**
 * Séquence relevée sur codex-cli 0.163.0 (`instant_interrupt` actif par défaut), sonde
 * `codex-steer-probe.ts` : un `turn/steer` pendant `item/agentMessage/delta` coupe la
 * réponse, qui ne reçoit jamais d'`item/completed` ; l'écho `userMessage` du steer
 * suit, puis une nouvelle réponse, dans le même tour.
 */
const userEcho = (id: string, text: string) => ({ type: 'userMessage', id, content: [{ type: 'text', text, text_elements: [] }] })
const answer = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null })
const delta = (itemId: string, text: string) => ({ method: 'item/agentMessage/delta', params: { threadId: 'root', turnId: 'turn-1', itemId, delta: text } })

async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), 'La séquence rejouée doit aboutir.')
}

test('steer pendant la réponse (instant_interrupt) : écho unique, réponse coupée close, un seul tour', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([
    itemEvent(userEcho('u1', 'liste'), 'item/started'), itemEvent(userEcho('u1', 'liste')),
    itemEvent(answer('cut', ''), 'item/started'), delta('cut', 'un\n'), delta('cut', 'deux\n'),
  ])
  const steer = JSON.stringify({ notifications: [
    delta('cut', 'trois\n'),
    itemEvent(userEcho('u2', 'stop'), 'item/started'), itemEvent(userEcho('u2', 'stop')),
    itemEvent(answer('next', ''), 'item/started'), delta('next', 'PINEAPPLE'), itemEvent(answer('next', 'PINEAPPLE')),
    // Hypothétique sur 0.163.0, mais un CLI qui clôt tard ne doit pas doubler le texte.
    itemEvent(answer('cut', 'un\ndeux\ntrois\nquatre\n')),
    done(),
  ] })
  assert.equal(await f.runner.steer(`fixture:${steer}`, [], [], []), true)
  await settled(() => f.events.some((event) => event.type === 'turn.completed'))

  const steerRecord = (await f.records()).find((record) => record.method === 'turn/steer')
  assert.equal(steerRecord.params.expectedTurnId, 'turn-1')
  const completed = f.events.filter((event) => event.type === 'message.completed')
  assert.deepEqual(completed.map((event) => event.role), ['user', 'user', 'assistant', 'assistant'])
  const [cut, next] = completed.slice(2)
  assert.ok(cut?.type === 'message.completed' && next?.type === 'message.completed')
  assert.equal(cut.messageId, 'cut')
  assert.deepEqual(cut.blocks, [{ type: 'text', text: 'un\ndeux\ntrois\n' }])
  assert.equal(next.messageId, 'next')
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').length, 1)
  assert.equal(f.statuses.at(-1), 'idle')
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('une réponse coupée sans item/completed est close avant la fin du tour', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([itemEvent(answer('cut', ''), 'item/started'), delta('cut', 'partiel'), done()])
  const types = f.events.map((event) => (event.type === 'message.completed' ? `${event.role}:${event.messageId}` : event.type))
  const closed = types.indexOf('assistant:cut')
  assert.ok(closed !== -1 && closed < types.indexOf('turn.completed'))
  // Un message ordinaire, clos par le CLI, ne l'est qu'une fois.
  await f.emit([itemEvent(answer('whole', ''), 'item/started'), delta('whole', 'ok'), itemEvent(answer('whole', 'ok')), done('turn-2')])
  assert.equal(f.events.filter((event) => event.type === 'message.completed' && event.messageId === 'whole').length, 1)
})
