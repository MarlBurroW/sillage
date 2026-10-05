import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_OPENCODE_CONFIG, sillageEventSchema, type McpServer } from '@sillage/protocol'
import { OpencodeRunner } from '../src/agents/opencode/runner.js'
import {
  ROOT, assistant, busy, context, delta, fixture, idle, part, runnerFixture, stepFinish, tool, until,
} from './opencode-support.js'

test('un tour : texte en deltas, outil normalisé, sortie en flux, édition, consommation', async (t) => {
  const f = await runnerFixture(t)
  await f.turn([
    busy(), assistant('msg_a'),
    part({ id: 'prt_think', type: 'reasoning', text: '', time: { start: 1 } }),
    delta('prt_think', 'Hmm'),
    part({ id: 'prt_think', type: 'reasoning', text: 'Hmm', time: { start: 1, end: 2 } }),
    tool('call_1', 'bash', { status: 'pending', input: {}, raw: '' }),
    tool('call_1', 'bash', { status: 'running', input: { command: 'echo hi' }, metadata: { output: 'hi\n' }, time: { start: 10 } }),
    tool('call_1', 'bash', { status: 'running', input: { command: 'echo hi' }, metadata: { output: 'hi\nthere\n' }, time: { start: 10 } }),
    tool('call_1', 'bash', { status: 'completed', input: { command: 'echo hi' }, output: 'hi\nthere\n', title: 'echo', metadata: {}, time: { start: 10, end: 35 } }),
    tool('call_2', 'edit', { status: 'completed', input: { filePath: `${f.cwd}/a.txt`, oldString: 'a', newString: 'b' }, output: 'ok', title: 'a.txt',
      metadata: { diff: 'Index: x\n===\n--- x\n+++ x\n@@ -1,1 +1,1 @@\n-a\n+b\n', filediff: { file: `${f.cwd}/a.txt` } }, time: { start: 40, end: 41 } }),
    part({ id: 'prt_text', type: 'text', text: '', time: { start: 1 } }),
    delta('prt_text', 'Bon'), delta('prt_text', 'jour'),
    part({ id: 'prt_text', type: 'text', text: 'Bonjour', time: { start: 1, end: 2 } }),
    stepFinish({ input: 100, output: 20, read: 400 }, 0.5),
    assistant('msg_a', { time: { created: 1, completed: 2 }, finish: 'stop' }),
    idle(), idle(),
  ])

  assert.equal(f.count('turn.started'), 1)
  assert.equal(f.count('turn.completed'), 1, 'le double `session.idle` ne clôt le tour qu\'une fois')
  assert.deepEqual(f.events.filter((event) => event.type === 'message.delta').map((event) => event.text), ['Bon', 'jour'])
  assert.deepEqual(f.events.filter((event) => event.type === 'thinking.delta').map((event) => event.text), ['Hmm'])
  const messages = f.events.filter((event) => event.type === 'message.completed' && event.role === 'assistant')
  assert.deepEqual(messages.map((event) => event.blocks), [[{ type: 'thinking', text: 'Hmm' }], [{ type: 'text', text: 'Bonjour' }]])

  const started = f.events.filter((event) => event.type === 'tool.started')
  assert.deepEqual(started.map((event) => event.name), ['Bash', 'Edit'])
  assert.deepEqual(started[1]!.input, { file_path: `${f.cwd}/a.txt`, old_string: 'a', new_string: 'b' })
  assert.deepEqual(f.events.find((event) => event.type === 'tool.input_updated')?.input, { command: 'echo hi' })
  assert.deepEqual(f.events.filter((event) => event.type === 'tool.output_delta').map((event) => event.chunk), ['hi\n', 'there\n'])
  const bash = f.events.find((event) => event.type === 'tool.completed' && event.toolCallId === 'call_1')
  assert.deepEqual(bash, { type: 'tool.completed', toolCallId: 'call_1', output: 'hi\nthere\n', isError: false, durationMs: 25 })
  assert.deepEqual(f.events.find((event) => event.type === 'file.edited'), { type: 'file.edited', toolCallId: 'call_2', path: 'a.txt', action: 'modified' })

  const usage = f.events.find((event) => event.type === 'usage.updated')
  assert.deepEqual(usage?.context, { usedTokens: 500, maxTokens: 1000, ratio: 0.5 })
  const done = f.events.find((event) => event.type === 'turn.completed')
  assert.deepEqual(done, { type: 'turn.completed', stopReason: 'completed', costUsd: 0.5, inputTokens: 100, outputTokens: 20, cacheReadTokens: 400, cacheCreationTokens: 0 })
  // Le fork retrouve son point de coupe dans le payload natif de la clôture.
  assert.deepEqual(f.raw[f.events.indexOf(done!)], { sessionID: ROOT, messageID: 'msg_a' })
  assert.deepEqual(f.statuses.slice(-2), ['running', 'idle'])
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('lancement : session, modèle par défaut, inventaire MCP, commandes et corps du message', async (t) => {
  const declared: McpServer = { id: 'a', name: 'declared', enabled: true, createdAt: 0, updatedAt: 0,
    transport: { type: 'stdio', command: 'node', args: ['server.mjs'], env: { KEY: 'v' } } }
  const f = await runnerFixture(t, {
    config: { ...DEFAULT_OPENCODE_CONFIG, model: 'fixture/small', variant: 'high', primaryAgent: 'plan', additionalDirectories: ['/extra'] },
    resolveMcpServers: () => ({ servers: [declared], failures: [{ name: 'secretless', error: 'Missing secret: X' }] }),
    skillRoots: () => ['/lib/global'], memoryDir: () => '/memory', projectOverview: () => 'OVERVIEW',
    maskedInstructionRoots: () => ['/repo'],
  })

  const launch = await f.launch()
  assert.equal(launch.disableProjectConfig, '1', 'les consignes du dépôt sont masquées')
  assert.deepEqual(launch.config.permission, {
    edit: 'ask', bash: 'ask',
    external_directory: { '/extra/**': 'allow', '/lib/global/**': 'allow', '/attachments/**': 'allow', '/memory/**': 'allow' },
  })
  assert.deepEqual(launch.config.mcp, { declared: { type: 'local', command: ['node', 'server.mjs'], environment: { KEY: 'v' }, enabled: true } })
  assert.deepEqual(launch.config.skills, { paths: ['/lib/global/skills'] })
  assert.equal(launch.config.autoupdate, false)

  await until(() => f.count('mcp.updated') > 0 && f.count('commands.updated') > 0)
  assert.deepEqual(f.events.find((event) => event.type === 'session.started'),
    { type: 'session.started', agent: 'opencode', agentSessionId: ROOT, model: 'fixture/small', cwd: f.cwd, tools: [] })
  assert.deepEqual(f.events.find((event) => event.type === 'mcp.updated')?.servers, [
    { name: 'secretless', state: 'failed', tools: [], error: 'Missing secret: X', external: false },
    { name: 'declared', state: 'connected', tools: [], error: null, external: false },
    { name: 'stray', state: 'failed', tools: [], error: 'boom', external: true },
  ])
  assert.deepEqual(f.events.find((event) => event.type === 'commands.updated')?.commands.map((command) => command.name), ['review', 'lib-skill'])

  await f.turn([busy(), idle()])
  const prompt = (await f.records()).find((record) => record.path.endsWith('/prompt_async'))!
  assert.deepEqual({ ...prompt.body, parts: prompt.body.parts.length }, {
    parts: 1, agent: 'plan', model: { providerID: 'fixture', modelID: 'small' }, variant: 'high', system: 'OVERVIEW',
  })

  // Une commande en `/` connue passe par sa route, pas par `prompt_async`.
  await f.runner.send(`/review fixture:${JSON.stringify({ events: [busy(), idle()] })}`, [], [])
  await until(() => f.count('turn.completed') === 2)
  const command = (await f.records()).find((record) => record.method === 'POST' && record.path.endsWith('/command'))!
  assert.equal(command.body.command, 'review')
  assert.equal(command.body.model, 'fixture/small')

  // Modèle et agent se changent à chaud ; une permission relance le serveur.
  assert.equal(await f.runner.applyConfig({ ...f.ctx.config, model: 'fixture/other' } as never), true)
  assert.equal(await f.runner.applyConfig({ ...f.ctx.config, permissions: { edit: 'allow', bash: 'ask', webfetch: '' } } as never), false)
})

test('sans modèle choisi, le défaut du CLI est annoncé et rien n\'est imposé au message', async (t) => {
  const f = await runnerFixture(t)
  const started = f.events.find((event) => event.type === 'session.started')
  assert.equal(started?.type === 'session.started' && started.model, 'fixture/small')
  await f.turn([busy(), idle()])
  const prompt = (await f.records()).find((record) => record.path.endsWith('/prompt_async'))!
  assert.deepEqual(Object.keys(prompt.body).sort(), ['agent', 'parts'])
})

test('permissions : portées traduites, demande close par opencode, expiration à la fin du tour', async (t) => {
  const f = await runnerFixture(t)
  const asked = (id: string, permission: string, metadata: Record<string, unknown>) => ({
    type: 'permission.asked',
    properties: { id, sessionID: ROOT, permission, patterns: ['x'], metadata, always: ['*'], tool: { messageID: 'msg_a', callID: 'call_1' } },
  })
  await f.play([
    busy(), assistant('msg_a'),
    asked('per_1', 'bash', { command: 'rm -rf build' }),
    asked('per_2', 'edit', { filepath: `${f.cwd}/src/a.ts`, diff: '@@' }),
    asked('per_3', 'bash', { command: 'ls' }),
    asked('per_4', 'webfetch', { url: 'https://example.com' }),
  ])
  await until(() => f.count('permission.requested') === 4)
  const requests = f.events.filter((event) => event.type === 'permission.requested')
  assert.deepEqual(requests.map((event) => [event.toolName, event.input]), [
    ['Bash', { command: 'rm -rf build' }],
    ['Edit', { file_path: 'src/a.ts', diff: '@@' }],
    ['Bash', { command: 'ls' }],
    ['WebFetch', { url: 'https://example.com' }],
  ])
  assert.equal(f.statuses.at(-1), 'awaiting_input')

  assert.equal(f.runner.resolvePermission(requests[0]!.requestId, { decision: 'allowed', scope: 'session', decidedBy: 'u' }), true)
  assert.equal(f.runner.resolvePermission(requests[1]!.requestId, { decision: 'denied', scope: 'once', decidedBy: 'u' }), true)
  assert.equal(f.runner.resolvePermission(requests[1]!.requestId, { decision: 'denied', scope: 'once', decidedBy: 'u' }), false)
  assert.equal(f.statuses.at(-1), 'awaiting_input', 'deux demandes attendent encore')

  // opencode clôt la troisième de lui-même, puis le tour s'arrête sur la quatrième.
  await f.runner.steer(`fixture:${JSON.stringify({ events: [{ type: 'permission.replied', properties: { sessionID: ROOT, requestID: 'per_3', reply: 'once' } }] })}`, [], [])
  await until(() => f.events.filter((event) => event.type === 'permission.resolved' && event.decision === 'expired').length === 1)
  await f.runner.interrupt()
  await until(() => f.count('turn.completed') === 1)

  assert.equal(f.events.filter((event) => event.type === 'permission.resolved' && event.decision === 'expired').length, 2)
  assert.equal(f.events.find((event) => event.type === 'turn.completed')?.stopReason, 'interrupted')
  assert.equal(f.count('error'), 0, 'une interruption n\'est pas une panne')
  assert.equal(f.statuses.at(-1), 'idle')

  await until(async () => (await f.records()).filter((record) => record.path.startsWith('/permission/')).length === 2).catch(() => {})
  const replies = (await f.records()).filter((record) => record.path.startsWith('/permission/'))
  assert.deepEqual(replies.map((record) => [record.path, record.body.reply]).sort(), [
    ['/permission/per_1/reply', 'always'],
    ['/permission/per_2/reply', 'reject'],
  ], 'ni la demande close par opencode ni celle du tour interrompu ne reçoivent de réponse')
})

test('questions : réponses rendues dans l\'ordre, refus sur une annulation', async (t) => {
  const f = await runnerFixture(t)
  const asked = (id: string) => ({ type: 'question.asked', properties: { id, sessionID: ROOT, questions: [
    { question: 'Couleur ?', header: 'Couleur', options: [{ label: 'Rouge', description: 'r' }, { label: 'Bleu', description: 'b' }] },
    { question: 'Fruits ?', header: 'Fruits', multiple: true, custom: false, options: [{ label: 'Kiwi', description: 'k' }] },
  ] } })
  await f.play([
    busy(), assistant('msg_a'),
    tool('call_q', 'question', { status: 'running', input: {}, time: { start: 1 } }),
    asked('que_1'), asked('que_2'),
  ])
  await until(() => f.count('question.requested') === 2)
  const [first, second] = f.events.filter((event) => event.type === 'question.requested')
  assert.deepEqual(first!.questions.map((question) => [question.id, question.multiSelect, question.allowOther]), [['0', false, true], ['1', true, false]])
  assert.equal(f.count('tool.started'), 0, 'la question tient lieu de carte d\'outil')

  assert.equal(f.runner.answerQuestion(first!.requestId, { status: 'answered', answers: { '1': ['Kiwi'], '0': ['Bleu'] }, decidedBy: 'u' }), true)
  assert.equal(f.runner.answerQuestion(second!.requestId, { status: 'cancelled', answers: {}, decidedBy: 'u' }), true)
  assert.equal(f.statuses.at(-1), 'running')

  const sent = async () => (await f.records()).filter((record) => record.path.startsWith('/question/'))
  for (let i = 0; i < 200 && (await sent()).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual((await sent()).map((record) => [record.path, record.body]).sort(), [
    ['/question/que_1/reply', { answers: [['Bleu'], ['Kiwi']] }],
    ['/question/que_2/reject', {}],
  ])
})

test('infléchir : refusé au repos, pris dans le tour en cours sans en ouvrir un autre', async (t) => {
  const f = await runnerFixture(t)
  assert.equal(await f.runner.steer('trop tôt', [], []), false)
  await f.play([busy(), assistant('msg_a')])
  await until(() => f.count('turn.started') === 1)
  assert.equal(await f.runner.steer(`fixture:${JSON.stringify({ events: [busy(), idle()] })}`, [], []), true)
  await until(() => f.count('turn.completed') === 1)
  assert.equal(f.count('turn.started'), 1)
  assert.equal(f.events.filter((event) => event.type === 'message.completed' && event.role === 'user').length, 2)
  assert.equal((await f.records()).filter((record) => record.path.endsWith('/prompt_async')).length, 2)
})

test('sous-agent : sa session se rattache à l\'appel task et ne clôt pas le tour', async (t) => {
  const f = await runnerFixture(t)
  const child = 'ses_child'
  await f.turn([
    busy(), assistant('msg_a'),
    { type: 'session.created', properties: { sessionID: child, info: { id: child, parentID: ROOT, title: 'Child', directory: '/' } } },
    tool('call_task', 'task', { status: 'running', input: { description: 'Explore', prompt: 'look', subagent_type: 'explore' },
      metadata: { sessionId: child }, time: { start: 1 } }),
    busy(child), assistant('msg_c', {}, child),
    tool('call_inner', 'read', { status: 'completed', input: { filePath: '/x' }, output: 'x', title: 'x', metadata: {}, time: { start: 1, end: 2 } }, 'msg_c', child),
    part({ id: 'prt_child', type: 'text', text: 'trouvé', time: { start: 1, end: 2 } }, 'msg_c', child),
    stepFinish({ input: 7, output: 3 }, 0.1, 'msg_c', child),
    idle(child),
    // Une session étrangère à l'arbre est ignorée.
    part({ id: 'prt_other', type: 'text', text: 'ailleurs', time: { start: 1, end: 2 } }, 'msg_o', 'ses_other'),
    tool('call_task', 'task', { status: 'completed', input: { description: 'Explore', prompt: 'look', subagent_type: 'explore' },
      output: 'trouvé', title: 'Explore', metadata: { sessionId: child }, time: { start: 1, end: 9 } }),
    idle(),
  ])
  assert.equal(f.count('turn.completed'), 1)
  const started = f.events.filter((event) => event.type === 'tool.started')
  assert.deepEqual(started.map((event) => [event.name, event.parentToolCallId]), [['Agent', null], ['Read', 'call_task']])
  const text = f.events.filter((event) => event.type === 'message.completed' && event.role === 'assistant')
  assert.deepEqual(text.map((event) => event.parentToolCallId), ['call_task'])
  // La consommation du sous-agent compte dans le tour, pas dans la jauge de contexte.
  const usage = f.events.find((event) => event.type === 'usage.updated')
  assert.equal(usage?.context, null)
  assert.equal(f.events.find((event) => event.type === 'turn.completed')?.inputTokens, 7)
})

test('panne de tour, plan, titre, compaction et événement inconnu', async (t) => {
  const f = await runnerFixture(t)
  const error = { name: 'ProviderAuthError', data: { providerID: 'fixture', message: 'Clé refusée' } }
  await f.turn([
    busy(), assistant('msg_a'),
    { type: 'todo.updated', properties: { sessionID: ROOT, todos: [
      { content: 'A', status: 'in_progress', priority: 'high' }, { content: 'B', status: 'cancelled', priority: 'low' }, { content: 'C', status: 'pending', priority: 'low' },
    ] } },
    { type: 'session.updated', properties: { sessionID: ROOT, info: { id: ROOT, title: 'New session - 2026-01-01T00:00:00.000Z' } } },
    { type: 'session.updated', properties: { sessionID: ROOT, info: { id: ROOT, title: 'Lire la note' } } },
    tool('call_1', 'bash', { status: 'running', input: { command: 'sleep 9' }, time: { start: 1 } }),
    { type: 'future.thing', properties: {} }, { type: 'future.thing', properties: {} },
    { type: 'server.heartbeat', properties: {} },
    { type: 'session.error', properties: { sessionID: ROOT, error } },
    assistant('msg_a', { error, time: { created: 1, completed: 2 } }),
    idle(),
    // opencode clôt l'outil après `idle` : le tour l'a déjà fait.
    tool('call_1', 'bash', { status: 'error', input: { command: 'sleep 9' }, error: 'Tool execution aborted', time: { start: 1, end: 2 } }),
  ])
  assert.deepEqual(f.events.find((event) => event.type === 'plan.updated')?.items, [{ text: 'A', status: 'in_progress' }, { text: 'C', status: 'pending' }])
  assert.equal(await f.runner.suggestedTitle(), 'Lire la note')
  assert.deepEqual(f.events.filter((event) => event.type === 'error'), [{ type: 'error', code: 'provider_unauthorized', message: 'Clé refusée', recoverable: true }])
  assert.equal(f.events.find((event) => event.type === 'turn.completed')?.stopReason, 'failed')
  assert.equal(f.events.filter((event) => event.type === 'agent.notice' && event.code === 'future.thing').length, 1)
  assert.equal(f.events.filter((event) => event.type === 'tool.completed' && event.toolCallId === 'call_1').length, 1)

  // Compaction demandée : annoncée une fois, résumé masqué, clôture journalisée.
  assert.equal(await f.runner.compact(), true)
  await f.turn([
    busy(), assistant('msg_s', { summary: true, mode: 'compaction' }),
    part({ id: 'prt_sum', type: 'text', text: 'Résumé', time: { start: 1, end: 2 } }, 'msg_s'),
    { type: 'session.compacted', properties: { sessionID: ROOT } },
    idle(),
  ])
  assert.equal(f.count('context.compaction_started'), 1)
  assert.equal(f.count('context.compacted'), 1)
  assert.ok(!f.events.some((event) => event.type === 'message.completed' && event.blocks.some((block) => block.type === 'text' && block.text === 'Résumé')))
  const summarize = (await f.records()).find((record) => record.path.endsWith('/summarize'))!
  assert.deepEqual(summarize.body, { providerID: 'fixture', modelID: 'small' })
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('reprise : la session existante est rouverte, une session disparue fait échouer le lancement', async (t) => {
  const resumed = await runnerFixture(t, { resumeSessionId: 'ses_kept' })
  const started = resumed.events.find((event) => event.type === 'session.started')
  assert.equal(started?.type === 'session.started' && started.agentSessionId, 'ses_kept')
  assert.ok(!(await resumed.records()).some((record) => record.method === 'POST' && record.path === '/session'))

  const transport = await fixture(t)
  const state = context({ cwd: transport.cwd, binary: transport.binary, resumeSessionId: 'ses_missing' })
  const runner = new OpencodeRunner(state.ctx)
  transport.onClose(() => runner.stop())
  await assert.rejects(runner.start(), /Session not found/)
  assert.equal(state.events.length, 0)
})

test('bibliothèque de skills : l\'instance est rechargée au repos, le flux rebranché', async (t) => {
  const f = await runnerFixture(t)
  await until(() => f.count('commands.updated') === 1)

  // Pendant un tour, la relecture attend : jeter l'instance emporterait le tour.
  await f.play([busy(), assistant('msg_a')])
  await until(() => f.count('turn.started') === 1)
  await f.runner.reloadSkillLibrary()
  assert.ok(!(await f.records()).some((record) => record.path === '/instance/dispose'))
  await f.runner.steer(`fixture:${JSON.stringify({ events: [idle()] })}`, [], [])
  await until(() => f.count('commands.updated') === 2, 'commandes republiées après le tour')
  assert.equal((await f.records()).filter((record) => record.path === '/instance/dispose').length, 1)

  // Le flux d'avant est muet : un tour qui aboutit prouve qu'il a été rebranché.
  await f.turn([busy(), idle()])
  assert.equal(f.count('turn.completed'), 2)

  await f.runner.reloadSkillLibrary()
  assert.equal((await f.records()).filter((record) => record.path === '/instance/dispose').length, 2)
  await f.turn([busy(), idle()])
  assert.equal(f.count('turn.completed'), 3)
})

test('un message refusé par opencode rend la main', async (t) => {
  const f = await runnerFixture(t)
  await assert.rejects(f.play([], { fail: 'Modèle inconnu' }), /Modèle inconnu/)
  assert.equal(f.statuses.at(-1), 'idle')
  assert.equal(f.count('turn.started'), 0)
})

test('mort du serveur : la conversation passe en erreur et la session se clôt', async (t) => {
  const f = await runnerFixture(t)
  await f.play([busy(), assistant('msg_a')])
  await until(() => f.count('turn.started') === 1)
  process.kill((await f.launch()).pid, 'SIGKILL')
  await until(() => f.count('session.ended') === 1)
  assert.equal(f.statuses.at(-1), 'error')
  assert.ok(f.events.some((event) => event.type === 'error' && event.code === 'runner_failed'))
})
