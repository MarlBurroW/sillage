import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CODEX_CONFIG, parseAgentConfig, sillageEventSchema } from '@sillage/protocol'
import { CodexRunner } from '../src/agents/codex/runner.js'
import { codexModel } from '../src/agents/codex/adapter.js'
import { CodexAppServerClient } from '../src/agents/codex/app-server-client.js'
import { runnerFixture, asyncMessage, context, done, fixture, itemEvent } from './codex-support.js'

test('session references reach CLI sends and steering without changing the journal text', async t => {
  const transport = await fixture(t)
  const seen: string[] = []
  const state = context({ ...transport, sessionReferenceContext: text => { seen.push(text); return 'Referenced session metadata' } })
  const runner = new CodexRunner(state.ctx)
  transport.onClose(() => runner.stop())
  await runner.start()
  await runner.send('Read this session', [], [], [])
  assert.equal(await runner.steer('Also compare this one', [], [], []), true)
  const turns = (await transport.records()).filter(record => ['turn/start', 'turn/steer'].includes(record.method))
  assert.equal(turns.length, 2)
  assert.deepEqual(seen, ['Read this session', 'Also compare this one'])
  for (const turn of turns) assert.match(turn.params.input[0].text, /Referenced session metadata/)
  // Without it app-server returns empty reasoning items and the thread shows no thinking.
  assert.equal(turns[0].params.summary, 'auto')
  const messages = state.events.filter(event => event.type === 'message.completed' && event.role === 'user')
  // The manager echoes sent messages; the runner only echoes steered ones.
  assert.deepEqual(messages.map(event => event.type === 'message.completed' && event.blocks), [
    [{ type: 'text', text: 'Also compare this one' }],
  ])
})

test('questions Astra interactives, non bloquantes et encore répondables après la fin du tour', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([itemEvent(asyncMessage), done()])
  const question = f.events.find((event) => event.type === 'question.requested')!
  assert.equal(question.type, 'question.requested')
  if (question.type !== 'question.requested') return
  assert.equal(question.blocking, false)
  assert.deepEqual(question.questions[0]!.options.map((option) => option.label), ['Blue', 'Green'])
  assert.equal(question.questions[1]!.allowOther, true)
  assert.equal(f.statuses.at(-1), 'idle') // Late RPC responses must not reactivate completed turns.
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
  await f.emit() // Transport barrier.
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
  const notices = f.events.filter((event) => event.type === 'agent.notice')
    .filter((event) => event.code === 'codex_event' && (event.details as { method: string }).method === 'future/progress')
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

test('sub-agent tokens are recorded apart, under their own model, even after the main turn', async (t) => {
  const f = await runnerFixture(t)
  const breakdown = (input: number, cached: number, output: number) =>
    ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 })
  const usage = (threadId: string, turnId: string, total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) =>
    ({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total, last, modelContextWindow: 100_000 } } })
  await f.emit([
    { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', agentNickname: 'Inspector', preview: 'Inspect', model: 'gpt-6-luna' } } },
    usage('root', 'turn-1', breakdown(1000, 800, 50), breakdown(1000, 800, 50)),
    usage('child', 'child-turn', breakdown(400, 300, 20), breakdown(400, 300, 20)),
    usage('child', 'child-turn', breakdown(900, 700, 45), breakdown(500, 400, 25)),
    // The parent finishes first: the sub-agent keeps working, and spending.
    done(),
    usage('child', 'child-turn', breakdown(1500, 1100, 60), breakdown(600, 400, 15)),
    done('child-turn', 'child'),
    // A thread Sillage never saw start still bills, under the session's model.
    usage('stray', 'stray-turn', breakdown(200, 0, 10), breakdown(200, 0, 10)),
    done('stray-turn', 'stray'),
  ])
  const turn = f.events.find((event) => event.type === 'turn.completed')
  assert.deepEqual(turn && { ...turn, stopReason: undefined }, { type: 'turn.completed', stopReason: undefined, costUsd: 0, inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheCreationTokens: 0 })
  assert.deepEqual(f.events.filter((event) => event.type === 'usage.consumed'), [
    { type: 'usage.consumed', costUsd: 0, model: 'gpt-6-luna', inputTokens: 400, outputTokens: 60, cacheReadTokens: 1100, cacheCreationTokens: 0 },
    { type: 'usage.consumed', costUsd: 0, model: null, inputTokens: 200, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ])
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('un message à un sous-agent terminé ne le remet pas en cours, un nouveau tour si', async (t) => {
  const f = await runnerFixture(t)
  const interacted = (id: string, agentThreadId: string, agentPath: string) =>
    itemEvent({ type: 'subAgentActivity', id, kind: 'interacted', agentThreadId, agentPath })
  const running = () => f.events.filter((event) => event.type === 'background.updated').at(-1)
  await f.emit([
    { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', agentNickname: 'Inspector', preview: 'Inspect' } } },
    done('child-turn', 'child'),
    // Parents message completed subagents; subagents had messaged `/root`.
    interacted('to-child', 'child', '/root/inspector'),
    interacted('to-root', 'root', '/root'),
  ])
  assert.deepEqual(running(), { type: 'background.updated', tasks: [] })
  assert.equal(f.events.filter((event) => event.type === 'task.started').length, 1)

  // Messages restart subagent turns; only that subagent becomes active until completion.
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
  // Roots belong to processes, not threads: set them before `thread/start`.
  assert.ok(set > methods.indexOf('initialized') && set < methods.indexOf('thread/start'))
  assert.deepEqual((await calls())[0].params.extraRoots, ['/library/global/skills', '/library/projects/p1/skills'])

  assert.equal(await runner.applyConfig({ ...DEFAULT_CODEX_CONFIG, skillLibrary: true }), true)
  assert.equal((await calls()).length, 1, 'mêmes racines, rien à renvoyer')
  // Reloading resends roots: app-servers do not notice removed directories themselves.
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

/** Sequence observed on codex-cli 0.163.0 with default `instant_interrupt`, probe `codex-steer-probe.ts`: `turn/steer` during `item/agentMessage/delta` interrupts responses without `item/completed`; steer `userMessage` echoes follow, then another response within the same turn. */
const userEcho = (id: string, text: string) => ({ type: 'userMessage', id, content: [{ type: 'text', text, text_elements: [] }] })
const answer = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null })
const delta = (itemId: string, text: string) => ({ method: 'item/agentMessage/delta', params: { threadId: 'root', turnId: 'turn-1', itemId, delta: text } })

async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), 'La séquence rejouée doit aboutir.')
}

for (const prefix of ['fixture:', 'fixture-late:']) test(`steer pendant la réponse (instant_interrupt) : écho unique, réponse coupée close, un seul tour (${prefix})`, async (t) => {
  const f = await runnerFixture(t)
  await f.emit([
    itemEvent(userEcho('u1', 'liste'), 'item/started'), itemEvent(userEcho('u1', 'liste')),
    itemEvent(answer('cut', ''), 'item/started'), delta('cut', 'un\n'), delta('cut', 'deux\n'),
  ])
  const steer = JSON.stringify({ notifications: [
    delta('cut', 'trois\n'),
    itemEvent(userEcho('u2', 'stop'), 'item/started'), itemEvent(userEcho('u2', 'stop')),
    itemEvent(answer('next', ''), 'item/started'), delta('next', 'PINEAPPLE'), itemEvent(answer('next', 'PINEAPPLE')),
    // Hypothetical on 0.163.0, but late completions must not duplicate text.
    itemEvent(answer('cut', 'un\ndeux\ntrois\nquatre\n')),
    done(),
  ] })
  assert.equal(await f.runner.steer(`${prefix}${steer}`, [], [], []), true)
  await settled(() => f.events.some((event) => event.type === 'turn.completed'))

  const steerRecord = (await f.records()).find((record) => record.method === 'turn/steer')
  assert.equal(steerRecord.params.expectedTurnId, 'turn-1')
  const completed = f.events.filter((event) => event.type === 'message.completed')
  // The sent message is echoed by the manager, not the runner: only the steer echo appears here.
  assert.deepEqual(completed.map((event) => event.role), ['user', 'assistant', 'assistant'])
  const [cut, next] = completed.slice(1)
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
  // Ordinary CLI-completed messages close only once.
  await f.emit([itemEvent(answer('whole', ''), 'item/started'), delta('whole', 'ok'), itemEvent(answer('whole', 'ok')), done('turn-2')])
  assert.equal(f.events.filter((event) => event.type === 'message.completed' && event.messageId === 'whole').length, 1)
})

/** Starts a runner on a fixture whose `turn/interrupt` misbehaves, with a reply cut mid-stream. */
async function interruptedFixture(t: import('node:test').TestContext, mode: 'ack' | 'silent') {
  const transport = await fixture(t)
  const state = context({ ...transport, processEnv: { FIXTURE_INTERRUPT: mode } })
  const runner = new CodexRunner(state.ctx)
  transport.onClose(() => runner.stop())
  await runner.start()
  await runner.send(`fixture:${JSON.stringify({ notifications: [itemEvent(answer('cut', ''), 'item/started'), delta('cut', 'partiel')] })}`, [], [], [])
  return { ...state, runner }
}

const kinds = (events: { type: string }[]) => events.map((event) => event.type === 'message.completed' ? 'message.completed' : event.type)

test('an interrupt Codex acknowledges but never completes still closes the turn in the journal', async (t) => {
  const grace = CodexRunner.interruptGraceMs
  CodexRunner.interruptGraceMs = 50
  t.after(() => { CodexRunner.interruptGraceMs = grace })
  const f = await interruptedFixture(t, 'ack')
  await f.runner.interrupt()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const types = kinds(f.events)
  const completed = f.events.filter((event) => event.type === 'turn.completed')
  assert.deepEqual(completed.map((event) => event.type === 'turn.completed' && event.stopReason), ['interrupted'])
  // The streamed text is kept as a message, inside the turn.
  assert.ok(types.indexOf('message.completed') !== -1 && types.indexOf('message.completed') < types.indexOf('turn.completed'))
  assert.equal(f.statuses.at(-1), 'idle')
})

test('an interrupt Codex never answers closes the turn and retires the wedged process', async (t) => {
  const f = await interruptedFixture(t, 'silent')
  // Shortened only now: on a slow runner, start-up calls such as `initialize` outlast 50 ms.
  const timeout = CodexAppServerClient.requestTimeoutMs
  CodexAppServerClient.requestTimeoutMs = 50
  t.after(() => { CodexAppServerClient.requestTimeoutMs = timeout })
  await f.runner.interrupt()
  const types = kinds(f.events)
  assert.ok(types.indexOf('turn.completed') !== -1 && types.indexOf('turn.completed') < types.indexOf('session.ended'))
  assert.ok(f.events.some((event) => event.type === 'error' && event.code === 'runner_failed'))
  assert.equal(f.statuses.at(-1), 'error')
  for (const event of f.events) sillageEventSchema.parse(event)
})

for (const resumeSessionId of [null, 'existing-thread']) {
  test(`configuration errors are actionable on ${resumeSessionId ? 'resume' : 'start'}`, async t => {
    const transport = await fixture(t)
    const state = context({ ...transport, resumeSessionId, processEnv: {
      FIXTURE_CONFIG_ERROR: 'failed to load configuration: url is not supported for stdio\nin `mcp_servers.sillage`\nsecret-value',
    } })
    const runner = new CodexRunner(state.ctx)
    transport.onClose(() => runner.stop())
    await assert.rejects(runner.start(), {
      statusCode: 400, code: 'codex_mcp_config_invalid', params: { server: 'sillage' },
    })
    assert.equal(state.events.some(event => event.type === 'session.started'), false)
  })
}

// Probed on codex-cli 0.172.0: thread/resume reports the mode of the thread's last turn, but a
// turn/start carrying collaborationMode runs in that mode; only an omitted field lets the restored
// one win. The conversation's mode must therefore travel on every turn, default included.
for (const [restored, wanted] of [['plan', 'default'], ['default', 'plan']] as const) {
  test(`a resumed thread restored in ${restored} runs the conversation's ${wanted} mode`, async t => {
    const transport = await fixture(t)
    const updates: unknown[] = []
    const state = context({
      ...transport, resumeSessionId: 'existing-thread', processEnv: { FIXTURE_RESTORED_MODE: restored },
      config: { ...DEFAULT_CODEX_CONFIG, collaborationMode: wanted },
      updateConfig: (config) => { updates.push(config) },
    })
    const runner = new CodexRunner(state.ctx)
    transport.onClose(() => runner.stop())
    await runner.start()
    await runner.send(`fixture:${JSON.stringify({ notifications: [done()] })}`, [], [], [])
    const records = await transport.records()
    assert.ok(records.some(record => record.method === 'thread/resume'))
    const turn = records.find(record => record.method === 'turn/start')
    assert.equal(turn.params.collaborationMode.mode, wanted)
    assert.equal(turn.params.collaborationMode.settings.model, 'fixture')
    // The conversation's setting is the one that runs: nothing to realign nor report.
    assert.deepEqual(updates, [])
    assert.equal(state.events.some(event => event.type === 'agent.notice'), false)
  })
}

test('a Codex sub-agent carries its model and effort on its Agent call, nested ones under their parent', async (t) => {
  const f = await runnerFixture(t)
  const activity = (id: string, kind: string, agentThreadId: string, agentPath: string, threadId: string, model: string | null = null, reasoningEffort: string | null = null) =>
    itemEvent({ type: 'subAgentActivity', id, kind, agentThreadId, agentPath, model, reasoningEffort }, 'item/completed', threadId)
  // Sequence probed on Codex 0.172.0: `started` names the resolved model and effort, the grandchild
  // is announced on its parent's thread, `completed` carries null for both.
  await f.emit([
    activity('a1', 'started', 'relay', '/root/relay', 'root', 'gpt-6.1-terra', 'medium'),
    { method: 'turn/started', params: { threadId: 'relay', turn: { id: 'relay-turn' } } },
    activity('a2', 'started', 'pong', '/root/relay/pong', 'relay', 'gpt-6.2-sol', 'low'),
    activity('a3', 'completed', 'pong', '/root/relay/pong', 'relay'),
    activity('a4', 'completed', 'relay', '/root/relay', 'root'),
  ])
  const agents = f.events.filter((event) => event.type === 'tool.started' && event.name === 'Agent')
  assert.deepEqual(agents.map((event) => event.type === 'tool.started' && event.input), [
    { description: '/root/relay', prompt: '/root/relay', model: 'gpt-6.1-terra', effort: 'medium' },
    { description: '/root/relay/pong', prompt: '/root/relay/pong', model: 'gpt-6.2-sol', effort: 'low' },
  ])
  const [relay, pong] = agents
  assert.ok(relay?.type === 'tool.started' && pong?.type === 'tool.started')
  assert.equal(relay.parentToolCallId, null)
  assert.equal(pong.parentToolCallId, relay.toolCallId)
  // Completion's null model must not wipe what started said.
  const agentIds = new Set(agents.map((event) => event.type === 'tool.started' && event.toolCallId))
  assert.ok(!f.events.some((event) => event.type === 'tool.input_updated' && agentIds.has(event.toolCallId)))
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('a model named after a Codex sub-agent started updates its Agent call', async (t) => {
  const f = await runnerFixture(t)
  await f.emit([
    // Probed on 0.169.0: the child's thread/started carries no model, the spawning call does.
    { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', agentNickname: 'Inspector', preview: 'Inspect', model: null, reasoningEffort: null } } },
    itemEvent({ type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed', senderThreadId: 'root',
      receiverThreadIds: ['child'], prompt: 'Inspect', model: 'gpt-6-luna', reasoningEffort: 'high', agentsStates: {} }),
  ])
  const started = f.events.find((event) => event.type === 'tool.started' && event.name === 'Agent')
  assert.ok(started?.type === 'tool.started')
  const updated = f.events.filter((event) => event.type === 'tool.input_updated' && event.toolCallId === started.toolCallId)
  assert.deepEqual(started.input, { description: 'Inspector', prompt: 'Inspect' })
  assert.deepEqual(updated, [{ type: 'tool.input_updated', toolCallId: started.toolCallId,
    input: { description: 'Inspector', prompt: 'Inspect', model: 'gpt-6-luna', effort: 'high' } }])
  for (const event of f.events) sillageEventSchema.parse(event)
})

// Sillage sends an explicit sandboxPolicy on every turn, which replaces config.toml's own. Probed
// on codex-cli 0.172.0: networkAccess false makes `curl` fail to resolve hosts and the model does
// not ask to escalate, so the value must follow the composer, or config.toml when left to the CLI.
for (const [setting, cli, sandbox, expected] of [
  ['', undefined, 'workspace-write', false],
  ['', 'true', 'workspace-write', true],
  ['', 'false', 'workspace-write', false],
  ['on', undefined, 'workspace-write', true],
  ['off', 'true', 'workspace-write', false],
  ['', 'true', 'read-only', false],
  ['on', undefined, 'read-only', true],
] as const) {
  test(`network access ${setting || 'CLI default'} with config.toml ${cli ?? 'unset'} in ${sandbox} → ${expected}`, async t => {
    const transport = await fixture(t)
    const state = context({
      ...transport, processEnv: cli ? { FIXTURE_CLI_NETWORK: cli } : {},
      config: { ...DEFAULT_CODEX_CONFIG, sandbox, networkAccess: setting },
    })
    const runner = new CodexRunner(state.ctx)
    transport.onClose(() => runner.stop())
    await runner.start()
    await runner.send(`fixture:${JSON.stringify({ notifications: [done()] })}`, [], [], [])
    const turn = (await transport.records()).find(record => record.method === 'turn/start')
    assert.equal(turn.params.sandboxPolicy.networkAccess, expected)
  })
}

test('a network access change applies on the next turn without restarting Codex', async t => {
  const f = await runnerFixture(t)
  await f.emit([done()])
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_CODEX_CONFIG, networkAccess: 'on' }), true)
  await f.emit([done('turn-2')])
  const turns = (await f.records()).filter(record => record.method === 'turn/start')
  assert.deepEqual(turns.map(turn => turn.params.sandboxPolicy.networkAccess), [false, true])
})

test('a configuration stored with the old webSearch flag reads as the CLI default network access', () => {
  const { networkAccess: _, ...current } = DEFAULT_CODEX_CONFIG
  const stored = parseAgentConfig(JSON.stringify({ ...current, webSearch: false, profile: null }))
  assert.equal(stored.agent === 'codex' && stored.networkAccess, '')
  assert.equal('webSearch' in stored || 'profile' in stored, false)
})

test('Sillage silences the warning about the feature it turns on itself', async t => {
  const f = await runnerFixture(t)
  const start = (await f.records()).find(record => record.method === 'thread/start')
  assert.equal(start.params.config['features.default_mode_request_user_input'], true)
  assert.equal(start.params.config.suppress_unstable_features_warning, true)
})

test('routine Codex notifications stay out of the thread; account changes and deprecations say something', async t => {
  const f = await runnerFixture(t)
  const account = (planType: string) => ({ method: 'account/updated', params: { authMode: 'chatgpt', planType, reason: 'workspaceRoutingReady' } })
  await f.emit([
    account('pro'), account('pro'),
    { method: 'thread/goal/cleared', params: { threadId: 'root' } },
    { method: 'deprecationNotice', params: { summary: 'Old flag is deprecated', details: 'Use the new one' } },
    account('plus'),
    done(),
  ])
  const notices = f.events.filter(event => event.type === 'agent.notice')
  assert.deepEqual(notices.map(event => [event.code, event.message]), [
    ['deprecationNotice', 'Old flag is deprecated\nUse the new one'],
    ['codex_account_changed', 'Codex account changed: plus'],
  ])
})

test('a sub-agent problem shows its own text: retries as information, usage limits as warnings', async t => {
  const f = await runnerFixture(t)
  const error = (message: string, willRetry: boolean, codexErrorInfo: unknown = null) => ({ method: 'error', params: {
    threadId: 'child', turnId: 'child-turn', willRetry, error: { message, codexErrorInfo, additionalDetails: null } } })
  await f.emit([
    { method: 'thread/started', params: { thread: { id: 'child', agentNickname: 'Euclid', parentThreadId: 'root', preview: '' } } },
    error('Reconnecting... 1/5', true),
    error("You've hit your usage limit.", false, 'usageLimitExceeded'),
    { method: 'warning', params: { threadId: 'child', message: 'Falling back from WebSockets to HTTPS transport.' } },
    done(),
  ])
  const notices = f.events.filter(event => event.type === 'agent.notice')
    .map(event => [event.code, event.level, event.details])
  assert.deepEqual(notices, [
    ['codex_retry', 'info', { agent: 'Euclid', message: 'Reconnecting... 1/5' }],
    ['codex_subagent_error', 'warning', { agent: 'Euclid', message: "You've hit your usage limit.", code: 'usage_limit_exceeded' }],
    ['codex_subagent_warning', 'warning', { agent: 'Euclid', message: 'Falling back from WebSockets to HTTPS transport.' }],
  ])
  // The parent turn is not failed by its sub-agent.
  assert.equal(f.events.some(event => event.type === 'error'), false)
})

// Probed on codex-cli 0.172.0: serviceTier applies to this turn and the next ones, an omitted
// field keeps the thread's tier and "default" is standard speed. Every turn must say which.
for (const [setting, cli, expected] of [
  ['', undefined, 'default'],
  ['', 'priority', 'priority'],
  ['ultrafast', 'priority', 'ultrafast'],
  ['default', 'priority', 'default'],
] as const) {
  test(`speed tier ${setting || 'CLI default'} with config.toml ${cli ?? 'unset'} → ${expected}`, async t => {
    const transport = await fixture(t)
    const state = context({
      ...transport, processEnv: cli ? { FIXTURE_CLI_TIER: cli } : {},
      config: { ...DEFAULT_CODEX_CONFIG, serviceTier: setting },
    })
    const runner = new CodexRunner(state.ctx)
    transport.onClose(() => runner.stop())
    await runner.start()
    await runner.send(`fixture:${JSON.stringify({ notifications: [done()] })}`, [], [], [])
    const turn = (await transport.records()).find(record => record.method === 'turn/start')
    assert.equal(turn.params.serviceTier, expected)
  })
}

test('going back to the CLI default speed after a fast turn returns to standard', async t => {
  const f = await runnerFixture(t)
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_CODEX_CONFIG, serviceTier: 'priority' }), true)
  await f.emit([done()])
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_CODEX_CONFIG, serviceTier: '' }), true)
  await f.emit([done('turn-2')])
  const turns = (await f.records()).filter(record => record.method === 'turn/start')
  assert.deepEqual(turns.map(turn => turn.params.serviceTier), ['priority', 'default'])
})

test('the catalog carries the speed tiers of each model as the CLI names and describes them', () => {
  const base = { id: 'm', model: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', description: '', isDefault: true,
    supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', defaultServiceTier: null }
  const tiers = [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' }]
  assert.deepEqual(codexModel({ ...base, serviceTiers: tiers } as never).serviceTiers, tiers)
  // A CLI that predates tiers lists none rather than breaking the catalog.
  assert.deepEqual(codexModel(base as never).serviceTiers, [])
})
