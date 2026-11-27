import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_OPENCODE_CONFIG, sillageEventSchema, type McpServer } from '@sillage/protocol'
import {
  CHILD, ROOT, childCreated, form, job, permission, report, runner2Fixture, started, step, stepEnded, succeeded, text,
  toolCall, toolProgress, toolSuccess, until, usage,
} from './opencode2-support.js'

test('OpenCode 2 : un tour, texte en deltas, outils normalisés, édition, consommation et format brut', async (t) => {
  const f = await runner2Fixture(t)
  const patch = 'Index: a.txt\n===\n--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n'
  await f.turn([
    started(), step('msg_a'),
    ...text('reasoning', 'msg_a', ['Hm', 'm']),
    ...toolCall('call_1', 'shell', { command: 'echo hi' }),
    toolSuccess('call_1', 'hi\n', { status: 'completed', exit: 0 }),
    ...toolCall('call_2', 'edit', { path: `${f.cwd}/a.txt`, oldString: 'a', newString: 'b' }),
    toolSuccess('call_2', 'Edited a.txt (1 replacement)', { files: [{ file: 'a.txt', patch, status: 'modified' }] }),
    ...toolCall('call_3', 'write', { path: `${f.cwd}/n.txt`, content: 'x' }),
    toolSuccess('call_3', 'Created file successfully: n.txt'),
    // The final text is authoritative: a suffix the deltas missed is caught up.
    ...text('text', 'msg_a', ['Bon'], 'Bonjour'),
    stepEnded('msg_a', { input: 100, output: 20, read: 400 }, 0.5),
    succeeded(),
  ])

  assert.equal(f.count('turn.started'), 1)
  assert.deepEqual(f.of('message.delta').map((event) => event.text), ['Bon', 'jour'])
  assert.deepEqual(f.of('thinking.delta').map((event) => event.text), ['Hm', 'm'])
  assert.deepEqual(f.of('message.completed').map((event) => event.blocks), [[{ type: 'thinking', text: 'Hmm' }], [{ type: 'text', text: 'Bonjour' }]])

  const tools = f.of('tool.started')
  assert.deepEqual(tools.map((event) => event.name), ['Bash', 'Edit', 'Write'])
  assert.deepEqual(f.of('tool.input_updated').map((event) => event.input), [
    { command: 'echo hi' },
    { file_path: `${f.cwd}/a.txt`, old_string: 'a', new_string: 'b' },
    { file_path: `${f.cwd}/n.txt`, content: 'x' },
  ])
  assert.deepEqual(f.of('tool.completed').map((event) => [event.toolCallId, event.output, event.isError]), [
    ['call_1', 'hi\n', false], ['call_2', 'Edited a.txt (1 replacement)', false], ['call_3', 'Created file successfully: n.txt', false],
  ])
  assert.deepEqual(f.of('file.edited').map((event) => [event.path, event.action]), [['a.txt', 'modified'], ['n.txt', 'created']])

  assert.deepEqual(f.of('usage.updated')[0]?.context, { usedTokens: 500, maxTokens: 1000, ratio: 0.5 })
  const done = f.of('turn.completed')[0]!
  assert.deepEqual(done, { type: 'turn.completed', stopReason: 'completed', costUsd: 0.5, inputTokens: 100, outputTokens: 20, cacheReadTokens: 400, cacheCreationTokens: 0 })
  assert.deepEqual(f.raw[f.events.indexOf(done)], { sessionID: ROOT, messageID: 'msg_a' })
  // Result raws carry the call they answer: 2.x results no longer repeat their input.
  const write = f.raw[f.events.findIndex((event) => event.type === 'tool.completed' && event.toolCallId === 'call_3')] as { call: unknown }
  assert.deepEqual(write.call, { tool: 'write', input: { path: `${f.cwd}/n.txt`, content: 'x' }, metadata: {}, output: 'Created file successfully: n.txt' })
  assert.ok(f.formats.every((format) => format === 'opencode-server@v2'), 'every journal entry is stamped 2.x')
  assert.deepEqual(f.statuses.slice(-2), ['running', 'idle'])
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('OpenCode 2 : lancement en configuration native, état de session synchronisé avant chaque message', async (t) => {
  const declared: McpServer = { id: 'a', name: 'declared', enabled: true, projectId: null, createdAt: 0, updatedAt: 0,
    transport: { type: 'stdio', command: 'node', args: ['server.mjs'], env: { KEY: 'v' } } }
  let overview = 'OVERVIEW'
  const f = await runner2Fixture(t, {
    config: { ...DEFAULT_OPENCODE_CONFIG, model: 'fixture/small', variant: 'high', primaryAgent: 'plan', additionalDirectories: ['/extra'] },
    resolveMcpServers: () => ({ servers: [declared], failures: [{ name: 'secretless', error: 'Missing secret: X' }] }),
    skillRoots: () => ['/lib/global'], memoryDir: () => '/memory', projectOverview: () => overview,
    maskedInstructionRoots: () => ['/repo'], mediaDir: '/media',
  })

  const launch = await f.launch()
  assert.equal(launch.disableProjectConfig, '1')
  assert.deepEqual(launch.config, {
    update: 'disable', share: 'disabled',
    permissions: [
      { action: 'edit', resource: '*', effect: 'ask' },
      { action: 'shell', resource: '*', effect: 'ask' },
      ...['/extra', '/lib/global', '/attachments', '/memory', '/media'].map((dir) => ({ action: 'external_directory', resource: `${dir}/**`, effect: 'allow' })),
    ],
    // Direct MCP calls rather than Code Mode's `execute`.
    mcp: { servers: { declared: { type: 'local', command: ['node', 'server.mjs'], environment: { KEY: 'v' }, disabled: false, codemode: false } } },
    skills: ['/lib/global/skills'],
  })

  await until(() => f.count('mcp.updated') > 0 && f.count('commands.updated') > 0)
  assert.deepEqual(f.of('session.started')[0], { type: 'session.started', agent: 'opencode', agentSessionId: ROOT, model: 'fixture/small', cwd: f.cwd, tools: [] })
  assert.deepEqual(f.of('mcp.updated')[0]?.servers.map((server) => [server.name, server.state, server.external]), [
    ['secretless', 'failed', false], ['declared', 'connected', false], ['stray', 'failed', true],
  ])
  assert.deepEqual(f.of('commands.updated')[0]?.commands.map((command) => command.name), ['review'])
  // Jobs die with the previous server: the journal must not keep them.
  assert.deepEqual(f.of('background.updated')[0], { type: 'background.updated', tasks: [] })

  await f.turn([started(), succeeded()])
  const records = await f.records()
  assert.deepEqual(records.find((record) => record.path === '/api/session')?.body, { location: { directory: f.cwd } })
  assert.deepEqual(records.find((record) => record.path === `/api/session/${ROOT}/model`)?.body, { model: { providerID: 'fixture', id: 'small', variant: 'high' } })
  assert.deepEqual(records.find((record) => record.path === `/api/session/${ROOT}/agent`)?.body, { agent: 'plan' })
  assert.deepEqual(records.find((record) => record.path.endsWith('/instructions/entries/sillage'))?.body, { value: 'OVERVIEW' })
  assert.deepEqual(Object.keys(records.find((record) => record.path.endsWith('/prompt'))!.body).sort(), ['files', 'skills', 'text'])

  // Durable session state: nothing resent while unchanged, the changed part only.
  await f.turn([started(), succeeded()])
  overview = 'NEW OVERVIEW'
  await f.turn([started(), succeeded()])
  const sync = (await f.records()).filter((record) => record.method !== 'GET' && /\/(model|agent|instructions\/entries\/sillage)$/.test(record.path))
  assert.deepEqual(sync.map((record) => [record.method, record.path.split('/').at(-1)]), [
    ['POST', 'model'], ['POST', 'agent'], ['PUT', 'sillage'], ['PUT', 'sillage'],
  ])

  // Known slash commands use their own route.
  await f.runner.send(`/review fixture:${JSON.stringify({ events: [started(), succeeded()] })}`, [], [], [])
  await until(() => f.count('turn.completed') === 4)
  const command = (await f.records()).find((record) => record.path === `/api/session/${ROOT}/command`)!
  assert.equal(command.body.name, 'review')

  assert.equal(await f.runner.applyConfig({ ...f.ctx.config, permissions: { edit: 'allow', bash: 'ask', webfetch: '' } } as never), false)

  // Model changes apply live; going back to the CLI default names it, the session would keep the last one.
  assert.equal(await f.runner.applyConfig({ ...f.ctx.config, model: 'fixture/other', variant: '' } as never), true)
  await f.turn([started(), succeeded()])
  assert.equal(await f.runner.applyConfig({ ...f.ctx.config, model: '', variant: '' } as never), true)
  await f.turn([started(), succeeded()])
  const models = (await f.records()).filter((record) => record.path === `/api/session/${ROOT}/model`).map((record) => record.body.model)
  assert.deepEqual(models.slice(-2), [{ providerID: 'fixture', id: 'other' }, { providerID: 'fixture', id: 'small' }])
})

test('OpenCode 2 : permissions et fichiers joints', async (t) => {
  const f = await runner2Fixture(t)
  await f.play([
    started(),
    permission('per_1', 'shell', ['rm -rf build'], { command: 'rm -rf build' }),
    permission('per_2', 'edit', ['src/a.ts'], { files: [{ file: 'src/a.ts', patch: '@@ -1 +1 @@', status: 'modified' }] }),
    permission('per_3', 'webfetch', ['https://example.com'], { url: 'https://example.com' }),
  ])
  await until(() => f.count('permission.requested') === 3)
  const requests = f.of('permission.requested')
  assert.deepEqual(requests.map((event) => [event.toolName, event.input]), [
    ['Bash', { command: 'rm -rf build' }],
    ['Edit', { file_path: 'src/a.ts', diff: '@@ -1 +1 @@' }],
    ['WebFetch', { url: 'https://example.com' }],
  ])
  assert.equal(f.statuses.at(-1), 'awaiting_input')
  f.runner.resolvePermission(requests[0]!.requestId, { decision: 'allowed', scope: 'once', decidedBy: 'u' })
  f.runner.resolvePermission(requests[1]!.requestId, { decision: 'allowed', scope: 'session', decidedBy: 'u' })
  f.runner.resolvePermission(requests[2]!.requestId, { decision: 'denied', scope: 'once', decidedBy: 'u' })
  await until(() => f.statuses.at(-1) === 'running')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const replies = (await f.records()).filter((record) => record.path.endsWith('/reply'))
  assert.deepEqual(replies.map((record) => [record.path, record.body.decision]), [
    [`/api/session/${ROOT}/permission/per_1/reply`, 'once'],
    // Never `always`: 2.x would save it as a permanent project rule.
    [`/api/session/${ROOT}/permission/per_2/reply`, 'once'],
    [`/api/session/${ROOT}/permission/per_3/reply`, 'reject'],
  ])

  // Closed by opencode itself (another client, an interruption): no reply sent.
  await f.play([permission('per_4', 'shell', ['ls']), { type: 'permission.replied', data: { sessionID: ROOT, requestID: 'per_4', reply: 'once' } }])
  await until(() => f.count('permission.resolved') === 4)
  await f.play([succeeded()])
  await until(() => f.count('turn.completed') === 1)
  assert.equal((await f.records()).filter((record) => record.path.endsWith('/reply')).length, 3)

  await f.runner.send(`fixture:${JSON.stringify({ events: [started(), succeeded()] })}`, [
    { id: 'a', filename: 'shot.png', mimeType: 'image/png', sizeBytes: 1, path: '/attachments/shot.png', inlineImage: true },
    { id: 'b', filename: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 1, path: '/attachments/notes.pdf', inlineImage: false },
  ], [{ relativePath: 'src/a.ts', path: `${f.cwd}/src/a.ts`, name: 'a.ts' }] as never, [])
  await until(() => f.count('turn.completed') === 2)
  const prompt = (await f.records()).filter((record) => record.path.endsWith('/prompt')).at(-1)!
  assert.deepEqual(prompt.body.files, [
    { uri: `file://${f.cwd}/src/a.ts`, name: 'src/a.ts' },
    { uri: 'file:///attachments/shot.png', name: 'shot.png' },
  ])
})

test('OpenCode 2 : les questions et les autres forms', async (t) => {
  const f = await runner2Fixture(t)
  await f.play([
    started(),
    ...toolCall('call_q', 'question', { questions: [] }),
    form('frm_1', 'question', [
      { key: 'q0', title: 'Language', description: 'Which language?', type: 'string', custom: true,
        options: [{ value: 'fr', label: 'French', description: 'Français' }, { value: 'en', label: 'English' }] },
      { key: 'q1', title: 'Files', description: 'Which files?', type: 'multiselect', options: [{ value: 'a.txt', label: 'a.txt' }, { value: 'b.txt', label: 'b.txt' }] },
    ]),
    form('frm_2', 'question', [{ key: 'q0', title: 'Again', type: 'string', options: [{ value: 'y', label: 'Yes' }] }]),
    form('frm_3', 'mcp-elicitation', [
      { key: 'token', title: 'Token', type: 'string', required: true },
      { key: 'count', type: 'integer', minimum: 1 },
      { key: 'ok', type: 'boolean' },
    ], ROOT, 'Need input'),
  ])
  await until(() => f.count('question.requested') === 2 && f.count('elicitation.requested') === 1)
  assert.equal(f.count('tool.started'), 0, 'the form replaces the question tool card')
  const [first, second] = f.of('question.requested')
  assert.deepEqual(first!.questions, [
    { id: 'q0', header: 'Language', question: 'Which language?', multiSelect: false, allowOther: true, secret: false,
      options: [{ label: 'French', description: 'Français', preview: null }, { label: 'English', description: '', preview: null }] },
    { id: 'q1', header: 'Files', question: 'Which files?', multiSelect: true, allowOther: false, secret: false,
      options: [{ label: 'a.txt', description: '', preview: null }, { label: 'b.txt', description: '', preview: null }] },
  ])
  const elicitation = f.of('elicitation.requested')[0]!
  assert.deepEqual([elicitation.mode, elicitation.message, elicitation.fields.map((field) => [field.name, field.kind, field.required])], [
    'form', 'Need input', [['token', 'text', true], ['count', 'number', false], ['ok', 'boolean', false]],
  ])

  // Labels go back as option values; free text passes as typed.
  f.runner.answerQuestion(first!.requestId, { status: 'answered', answers: { q0: ['French'], q1: ['a.txt', 'b.txt'] }, decidedBy: 'u' })
  f.runner.answerQuestion(second!.requestId, { status: 'cancelled', answers: {}, decidedBy: 'u' })
  f.runner.resolveElicitation(elicitation.requestId, { action: 'accept', content: { token: 't', count: 2, ok: true }, decidedBy: 'u' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  // Answers leave concurrently: compare them in a stable order.
  const answers = (await f.records()).filter((record) => record.path.includes('/form/'))
    .map((record) => [record.method, record.path.split('/').slice(-2).join('/'), record.body] as const)
    .sort((a, b) => a[1].localeCompare(b[1]))
  assert.deepEqual(answers, [
    ['DELETE', 'form/frm_2', null],
    ['POST', 'frm_1/reply', { answer: { q0: 'fr', q1: ['a.txt', 'b.txt'] } }],
    ['POST', 'frm_3/reply', { answer: { token: 't', count: 2, ok: true } }],
  ])
})

test('OpenCode 2 : sous-agent de fond, tour de réveil, demande de l\'enfant pendant le repos du parent', async (t) => {
  const f = await runner2Fixture(t)
  await f.turn([
    started(), step('msg_a'),
    ...toolCall('call_sub', 'subagent', { agent: 'general', description: 'Read note', prompt: 'Read note.txt' }),
    childCreated(),
    toolProgress('call_sub', { sessionID: CHILD, status: 'running' }),
    job('running'),
    toolSuccess('call_sub', 'The subagent is working in the background', { sessionID: CHILD, status: 'running' }),
    stepEnded('msg_a', { input: 10, output: 1 }),
    succeeded(),
  ])
  assert.equal(f.of('tool.started')[0]?.name, 'Agent')
  assert.deepEqual(f.of('tool.input_updated')[0]?.input, { subagent_type: 'general', description: 'Read note', prompt: 'Read note.txt' })
  assert.deepEqual(f.of('task.started')[0], { type: 'task.started', taskId: CHILD, toolCallId: 'call_sub', kind: 'local_agent', description: 'Read note', workflowName: null })
  assert.deepEqual(f.of('background.updated').at(-1)?.tasks, [{ id: CHILD, kind: 'local_agent', description: 'Read note' }])
  assert.equal(f.of('turn.completed')[0]?.inputTokens, 10)

  // The child works while the parent rests: its output nests under the call, its request waits.
  await f.play([
    step('msg_c', CHILD),
    ...text('text', 'msg_c', ['hello'], undefined, CHILD),
    permission('per_child', 'shell', ['cat note.txt'], {}, CHILD),
    stepEnded('msg_c', { input: 7, output: 3 }, 0, CHILD),
  ])
  await until(() => f.count('permission.requested') === 1)
  assert.equal(f.of('message.completed').at(-1)?.parentToolCallId, 'call_sub')
  assert.equal(f.statuses.at(-1), 'awaiting_input')

  // The report reaches the parent's inbox, the job closes, and the parent wakes without a message.
  await f.play([
    report('note.txt holds hello'),
    job('completed'),
    started(), step('msg_b'),
    ...text('text', 'msg_b', ['Done']),
    stepEnded('msg_b', { input: 5, output: 2 }),
    succeeded(),
  ])
  await until(() => f.count('turn.completed') === 2)
  assert.deepEqual(f.of('task.completed')[0], { type: 'task.completed', taskId: CHILD, status: 'completed', summary: 'note.txt holds hello', durationMs: 3000, ambient: false })
  assert.deepEqual(f.of('background.updated').at(-1)?.tasks, [])
  assert.equal(f.count('turn.started'), 2)
  // The child's spending between parent turns lands in the next one.
  assert.equal(f.of('turn.completed')[1]?.inputTokens, 12)
  // Ending the wake-up turn did not expire the child's request.
  assert.equal(f.count('permission.resolved'), 0)
  assert.equal(f.statuses.at(-1), 'awaiting_input')
})

test('OpenCode 2 : « pour la session » reste dans la conversation, jamais une règle opencode', async (t) => {
  const f = await runner2Fixture(t)
  const replies = async (expected: number) => {
    let found: unknown[][] = []
    for (let tries = 0; tries < 500 && found.length < expected; tries++) {
      found = (await f.records()).filter((record) => record.path.endsWith('/reply')).map((record) => [record.path.split('/')[5], record.body.decision])
      if (found.length < expected) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return found
  }
  // 2.x proposes saving the command family (`echo *`), probed on 2.4.2.
  await f.play([started(), permission('per_1', 'shell', ['echo one'], { command: 'echo one' }, ROOT, ['echo *'])])
  await until(() => f.count('permission.requested') === 1)
  f.runner.resolvePermission(f.of('permission.requested')[0]!.requestId, { decision: 'allowed', scope: 'session', decidedBy: 'u' })
  assert.equal((await replies(1)).length, 1)

  // Same family, a sub-agent included: answered `once` by Sillage without asking again.
  // Another command or another action with the same text still asks.
  await f.play([
    childCreated(),
    permission('per_2', 'shell', ['echo two'], {}),
    permission('per_3', 'shell', ['echo'], {}, CHILD),
    permission('per_4', 'shell', ['echo three', 'rm -rf build'], {}),
    permission('per_5', 'webfetch', ['echo two'], {}),
  ])
  await until(() => f.count('permission.requested') === 3)
  assert.deepEqual(await replies(3), [['per_1', 'once'], ['per_2', 'once'], ['per_3', 'once']])
  assert.deepEqual(f.of('permission.requested').slice(1).map((event) => event.input), [{ command: 'echo three && rm -rf build' }, { url: 'echo two' }])
})

test('OpenCode 2 : compaction et titre comptés, sans doubler les étapes', async (t) => {
  const f = await runner2Fixture(t)
  const totals = (event: { costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }) =>
    [Number(event.costUsd.toFixed(6)), event.inputTokens, event.outputTokens, event.cacheReadTokens]

  // Each step is reported again in the running total: counted once. A title generated during
  // the turn has no step: its share joins the turn.
  await f.turn([
    started(), step('msg_a'),
    stepEnded('msg_a', { input: 100, output: 20, read: 400 }, 0.5), usage({ input: 100, output: 20, read: 400 }, 0.5),
    usage({ input: 160, output: 30, read: 400 }, 0.6),
    succeeded(),
    // A title generated after the execution ended: reported on its own.
    usage({ input: 200, output: 35, read: 400 }, 0.65),
  ])
  await until(() => f.count('usage.consumed') === 1)
  assert.deepEqual(totals(f.of('turn.completed')[0]!), [0.6, 160, 30, 400])
  assert.deepEqual(totals(f.of('usage.consumed')[0]!), [0.05, 40, 5, 0])

  // A compaction has no step at all: its turn used to close at zero.
  await f.turn([
    started(),
    { type: 'session.compaction.started', data: { sessionID: ROOT } },
    usage({ input: 1200, output: 135, read: 900 }, 1.65),
    { type: 'session.compaction.ended', data: { sessionID: ROOT, reason: 'manual' } },
    succeeded(),
  ])
  assert.deepEqual(totals(f.of('turn.completed')[1]!), [1, 1000, 100, 500])

  // A sub-agent's steps and its own running total are not counted twice either.
  await f.turn([
    started(), childCreated(),
    stepEnded('msg_c', { input: 7, output: 3 }, 0, CHILD), usage({ input: 7, output: 3 }, 0, CHILD),
    succeeded(),
  ])
  assert.deepEqual(totals(f.of('turn.completed')[2]!), [0, 7, 3, 0])
  assert.equal(f.count('usage.consumed'), 1)
})

test('OpenCode 2 : une session reprise ne recompte pas ce qu’elle avait dépensé', async (t) => {
  const f = await runner2Fixture(t, { resumeSessionId: 'ses_spent' })
  await f.turn([
    started('ses_spent'), step('msg_a', 'ses_spent'),
    stepEnded('msg_a', { input: 100, output: 20 }, 0.5, 'ses_spent'), usage({ input: 5100, output: 320 }, 2.5, 'ses_spent'),
    succeeded('ses_spent'),
  ])
  assert.equal(f.of('turn.completed')[0]?.inputTokens, 100)
  assert.equal(f.of('turn.completed')[0]?.outputTokens, 20)
  assert.equal(f.count('usage.consumed'), 0)
})

test('OpenCode 2 : appairage push ignoré, événement inconnu signalé une fois', async (t) => {
  const f = await runner2Fixture(t)
  await f.turn([
    started(),
    { type: 'experimental.push.updated', data: { devices: [] } },
    { type: 'experimental.future.thing', data: {} },
    { type: 'experimental.future.thing', data: {} },
    succeeded(),
  ])
  assert.deepEqual(f.of('agent.notice').map((event) => event.code), ['experimental.future.thing'])
})

test('OpenCode 2 : un sous-agent mentionné part avec le message', async (t) => {
  const f = await runner2Fixture(t)
  const prompts = async () => (await f.records()).filter((record) => record.path.endsWith('/prompt')).map((record) => record.body.agents)
  // The fixture lists `build` (primary), `title` (hidden) and `general` (sub-agent).
  await f.runner.send(`fixture:${JSON.stringify({ events: [started(), succeeded()] })}\n@general read note.txt, not @build or @title`, [], [], [])
  await until(() => f.count('turn.completed') === 1)
  await f.runner.send(`fixture:${JSON.stringify({ events: [started()] })}\nno agent here`, [], [], [])
  await until(() => f.count('turn.started') === 2)
  // While the turn runs, a steering message names one too.
  assert.equal(await f.runner.steer('@general as well', [], [], []), true)
  const sent = await prompts()
  const at = sent[0][0].mention.start
  assert.deepEqual(sent, [
    [{ name: 'general', mention: { start: at, end: at + 8, text: '@general' } }],
    undefined,
    [{ name: 'general', mention: { start: 0, end: 8, text: '@general' } }],
  ])
})

test('OpenCode 2 : interruption, échec et reprise', async (t) => {
  const f = await runner2Fixture(t, { resumeSessionId: 'ses_old' })
  assert.equal(f.of('session.started')[0]?.agentSessionId, 'ses_old')
  assert.ok((await f.records()).some((record) => record.method === 'GET' && record.path === '/api/session/ses_old'))

  await f.play([started('ses_old')])
  await until(() => f.count('turn.started') === 1)
  await f.runner.interrupt()
  await until(() => f.count('turn.completed') === 1)
  assert.equal(f.of('turn.completed')[0]?.stopReason, 'interrupted')

  await f.turn([
    started('ses_old'),
    { type: 'session.execution.failed', data: { sessionID: 'ses_old', error: { type: 'ProviderAuthError', message: 'bad key' } } },
  ])
  assert.deepEqual(f.of('error')[0], { type: 'error', code: 'provider_unauthorized', message: 'bad key', recoverable: true })
  assert.equal(f.of('turn.completed')[1]?.stopReason, 'failed')
})

test('OpenCode 2 : skills proposées et jointes au prompt, commandes séparées', async (t) => {
  const f = await runner2Fixture(t)
  await until(() => f.count('skills.updated') > 0)
  assert.deepEqual(f.of('skills.updated')[0]?.skills, [{ name: 'lib-skill', description: 'From the library' }])
  assert.deepEqual(f.of('commands.updated')[0]?.commands.map((command) => command.name), ['review'])

  // Only skills the CLI published are attached; unknown names are dropped.
  await f.runner.send(`fixture:${JSON.stringify({ events: [started(), succeeded()] })}`, [], [], ['lib-skill', 'ghost'])
  await until(() => f.count('turn.completed') === 1)
  const prompt = (await f.records()).filter((record) => record.path.endsWith('/prompt')).at(-1)!
  assert.deepEqual(prompt.body.skills, [{ id: 'lib-skill' }])
})

test('OpenCode 2 : sortie shell en direct, commande de fond suivie, lue et arrêtée', async (t) => {
  const f = await runner2Fixture(t)
  // A foreground shell call: its output is paged while it runs, then the result closes it.
  await f.play([
    started(),
    ...toolCall('call_sh', 'shell', { command: 'make' }),
    toolProgress('call_sh', { shellID: 'sh_fg' }),
  ], { shells: { sh_fg: 'building\n' } })
  await until(() => f.count('tool.output_delta') > 0)
  assert.deepEqual(f.of('tool.output_delta').map((event) => [event.toolCallId, event.chunk]), [['call_sh', 'building\n']])
  await f.play([toolSuccess('call_sh', 'building\ndone\n', { status: 'completed', exit: 0 }), succeeded()])
  await until(() => f.count('turn.completed') === 1)
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(f.count('tool.output_delta'), 1, 'no reading after the result')

  // A background shell: the call returns at once, the job carries on and reports to the inbox.
  const shellJob = (status: string) => ({ type: 'experimental.job.updated', data: { info: {
    kind: 'shell', id: 'sh_bg', sessionID: ROOT, status, title: 'npm test', shellID: 'sh_bg', command: 'npm test',
    time: { started: 1000, ...(status === 'running' ? {} : { completed: 2500 }) },
  } } })
  await f.turn([
    started(),
    ...toolCall('call_bg', 'shell', { command: 'npm test', background: true }),
    toolProgress('call_bg', { shellID: 'sh_bg' }),
    shellJob('running'),
    toolSuccess('call_bg', 'Command moved to the background (shell ID: sh_bg)'),
    succeeded(),
  ])
  assert.deepEqual(f.of('task.started')[0], { type: 'task.started', taskId: 'sh_bg', toolCallId: 'call_bg', kind: 'local_bash', description: 'npm test', workflowName: null })
  await f.play([], { shells: { sh_bg: 'x'.repeat(9000) + 'tail' } })
  const output = await f.runner.readBackgroundTaskOutput('sh_bg')
  assert.deepEqual([output?.totalBytes, output?.truncated, output?.output.length, output?.output.endsWith('tail')], [9004, true, 8192, true])
  assert.equal(await f.runner.readBackgroundTaskOutput('ses_child'), null, 'subagents have no shell output')

  assert.equal(await f.runner.stopBackgroundTask('sh_bg'), true)
  assert.ok((await f.records()).some((record) => record.method === 'POST' && record.path === '/api/experimental/job/sh_bg/cancel'))

  await f.play([
    { type: 'session.inbox.enqueued', data: { sessionID: ROOT, inboxID: 'msg_in', item: { type: 'synthetic',
      payload: { text: '<background-result kind="shell" id="sh_bg" state="completed" command="npm test">\nall green\n</background-result>' } } } },
    shellJob('completed'),
  ])
  await until(() => f.count('task.completed') === 1)
  assert.deepEqual(f.of('task.completed')[0], { type: 'task.completed', taskId: 'sh_bg', status: 'completed', summary: 'all green', durationMs: 1500, ambient: false })
})
