import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  DEFAULT_GROK_CONFIG,
  sillageEventSchema,
  type ConversationStatus,
  type McpServer,
  type SillageEvent,
} from '@sillage/protocol'
import { GrokRunner } from '../src/agents/grok/runner.js'
import type { RunnerContext } from '../src/agents/types.js'

async function runnerFixture(t: TestContext, overrides: Partial<RunnerContext> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'sillage-grok-test-'))
  const binary = join(cwd, 'grok.mjs')
  await copyFile(new URL('./fixtures/grok-agent.mjs', import.meta.url), binary)
  await chmod(binary, 0o700)

  const events: SillageEvent[] = []
  const raw: unknown[] = []
  const statuses: ConversationStatus[] = []
  const ctx: RunnerContext = {
    conversationId: 'test', cwd, binary, attachmentsRoot: '/attachments',
    config: DEFAULT_GROK_CONFIG, resumeSessionId: null,
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
    emit: (event, native) => { events.push(event); raw.push(native) },
    setStatus: (status) => { statuses.push(status) }, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => randomUUID(), closePermissionRequest: () => {},
    ...overrides,
  }
  const runner = new GrokRunner(ctx)
  t.after(async () => {
    await runner.stop()
    await rm(cwd, { recursive: true, force: true })
  })
  await runner.start()

  const count = (type: SillageEvent['type']) => events.filter((event) => event.type === type).length
  const lines = async (file: string) =>
    (await readFile(join(cwd, file), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return {
    cwd, ctx, events, raw, statuses, runner, count,
    rpc: () => lines('rpc.jsonl') as Promise<{ method?: string; params?: any; answer?: { method: string; result: any } }[]>,
    launch: async () => JSON.parse(await readFile(join(cwd, 'launch.json'), 'utf8')) as { args: string[]; env: Record<string, string> },
    play: (scenario: Record<string, unknown>) => runner.send(`fixture:${JSON.stringify(scenario)}`, [], [], []),
    turn: async (scenario: Record<string, unknown>) => {
      const before = count('turn.completed')
      await runner.send(`fixture:${JSON.stringify(scenario)}`, [], [], [])
      await until(() => count('turn.completed') > before, 'turn.completed')
    },
  }
}

async function until(check: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const update = (value: Record<string, unknown>, meta?: Record<string, unknown>) => ({ update: value, ...(meta ? { meta } : {}) })
const tool = (name: string, kind: string) => ({ 'x.ai/tool': { version: 1, name, kind, namespace: 'grok_build' } })

test('un tour : réflexion, texte, outils normalisés, sortie en flux, édition, consommation', async (t) => {
  const f = await runnerFixture(t)
  await f.turn({
    steps: [
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hm' } }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'm' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Je ' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lis.' } }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read_file', rawInput: { target_file: `${f.cwd}/a.txt` }, _meta: tool('read_file', 'read') }, { totalTokens: 500 }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '1→a\n' } }] }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'run_terminal_command', rawInput: { command: 'echo hi', description: 'Say hi' }, _meta: tool('run_terminal_command', 'execute') }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'in_progress', rawOutput: { type: 'Bash', output: [...Buffer.from('hi\n')] } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'in_progress', rawOutput: { type: 'Bash', output: [...Buffer.from('hi\nthere\n')] } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed', rawOutput: { type: 'Bash', output: [...Buffer.from('hi\nthere\n')], output_for_prompt: 'exit: 0\nhi\nthere\n' } }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'c3', title: 'search_replace', rawInput: { file_path: `${f.cwd}/a.txt`, old_string: 'a', new_string: 'b' }, _meta: tool('search_replace', 'edit') }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'c3', kind: 'edit', rawInput: { variant: 'SearchReplace', file_path: `${f.cwd}/a.txt`, old_string: 'a', new_string: 'b', replace_all: false },
        content: [{ type: 'diff', path: `${f.cwd}/a.txt`, oldText: 'a', newText: 'b' }] }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'c3', status: 'completed' }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'c4', title: 'use_tool', rawInput: { tool_name: 'sillage__read_card', tool_input: { number: 3 } }, _meta: tool('use_tool', 'use_tool') }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'c4', status: 'completed', rawOutput: { type: 'MCP', output: { OkayOutput: 'card' } } }),
      update({ sessionUpdate: 'plan', entries: [{ content: 'Lire', priority: 'medium', status: 'completed' }, { content: 'Écrire', priority: 'medium', status: 'pending' }] }),
      update({ sessionUpdate: 'session_info_update', title: 'Lire et écrire' }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fini.' } }),
    ],
    usage: { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 800, costUsdTicks: 330_000_000 },
  })

  assert.deepEqual(f.events.filter((event) => event.type === 'thinking.delta').map((event) => event.text), ['Hm', 'm'])
  const messages = f.events.filter((event) => event.type === 'message.completed' && event.role === 'assistant')
  assert.deepEqual(messages.map((event) => event.blocks), [
    [{ type: 'thinking', text: 'Hmm' }], [{ type: 'text', text: 'Je lis.' }], [{ type: 'text', text: 'Fini.' }],
  ])

  const started = f.events.filter((event) => event.type === 'tool.started')
  assert.deepEqual(started.map((event) => event.name), ['Read', 'Bash', 'Edit', 'sillage/read_card'])
  assert.deepEqual(started[0]!.input, { file_path: `${f.cwd}/a.txt` })
  assert.deepEqual(started[3]!.input, { number: 3 })
  assert.deepEqual(f.events.find((event) => event.type === 'tool.input_updated'),
    { type: 'tool.input_updated', toolCallId: 'c3', name: 'Edit', presentation: {}, input: { file_path: `${f.cwd}/a.txt`, old_string: 'a', new_string: 'b', replace_all: false } })
  assert.deepEqual(f.events.filter((event) => event.type === 'tool.output_delta').map((event) => event.chunk), ['hi\n', 'there\n'])
  const completed = f.events.filter((event) => event.type === 'tool.completed')
  assert.deepEqual(completed.map((event) => [event.toolCallId, event.output, event.isError]), [
    ['c1', '1→a\n', false],
    ['c2', 'hi\nthere\n', false],
    ['c3', '', false],
    // Model-facing text stored under Grok's Rust enum variant.
    ['c4', 'card', false],
  ])
  assert.deepEqual(f.events.find((event) => event.type === 'file.edited'), { type: 'file.edited', toolCallId: 'c3', path: 'a.txt', action: 'modified' })
  // `diff` blocks accompany completions so `describeEdit` can recover excerpts.
  const editClose = completed.find((event) => event.toolCallId === 'c3')!
  assert.deepEqual((f.raw[f.events.indexOf(editClose)] as { diffs: unknown }).diffs, [{ path: `${f.cwd}/a.txt`, oldText: 'a', newText: 'b' }])

  assert.deepEqual(f.events.find((event) => event.type === 'plan.updated'),
    { type: 'plan.updated', items: [{ text: 'Lire', status: 'completed' }, { text: 'Écrire', status: 'pending' }] })
  assert.deepEqual(f.events.find((event) => event.type === 'usage.updated')?.context, { usedTokens: 500, maxTokens: 1000, ratio: 0.5 })
  assert.equal(await f.runner.suggestedTitle(), 'Lire et écrire')

  const done = f.events.find((event) => event.type === 'turn.completed')
  assert.ok(done && done.type === 'turn.completed')
  assert.equal(done.stopReason, 'completed')
  assert.equal(done.inputTokens, 200, 'le cache est retiré des tokens d’entrée')
  assert.equal(done.cacheReadTokens, 800)
  assert.ok(Math.abs(done.costUsd - 0.033) < 1e-9)
  assert.deepEqual(f.statuses.slice(-2), ['running', 'idle'])
  for (const event of f.events) sillageEventSchema.parse(event)
})

test('lancement : isolation, MCP, modèle et effort posés à la création, commandes', async (t) => {
  const declared: McpServer = { id: 'a', name: 'declared', enabled: true, createdAt: 0, updatedAt: 0,
    transport: { type: 'stdio', command: 'node', args: ['server.mjs'], env: { KEY: 'v' } } }
  const remote: McpServer = { id: 'b', name: 'remote', enabled: true, createdAt: 0, updatedAt: 0,
    transport: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } }
  const f = await runnerFixture(t, {
    config: { ...DEFAULT_GROK_CONFIG, model: 'grok-fast', reasoningEffort: 'low', webSearch: false, additionalDirectories: ['/extra'] },
    resolveMcpServers: () => ({ servers: [declared, remote], failures: [{ name: 'secretless', error: 'Missing secret: X' }] }),
    skillRoots: () => ['/lib/global'], memoryDir: () => '/memory',
  })

  const launch = await f.launch()
  assert.deepEqual(launch.args, ['--disable-web-search', 'agent', '--no-leader', '--plugin-dir', '/lib/global', 'stdio'])
  assert.equal(launch.env.GROK_CLAUDE_MCPS_ENABLED, '0', 'les serveurs MCP de Claude ne sont pas relus')
  assert.equal(launch.env.GROK_CLAUDE_RULES_ENABLED, '0')
  assert.equal(launch.env.GROK_DISABLE_AUTOUPDATER, '1')
  assert.equal(launch.env.GROK_TELEMETRY_TRACE_UPLOAD, 'false')
  assert.equal(launch.env.GROK_FOLDER_TRUST, '0')

  const rpc = await f.rpc()
  const created = rpc.find((entry) => entry.method === 'session/new')!
  assert.deepEqual(created.params.mcpServers, [
    { name: 'declared', command: 'node', args: ['server.mjs'], env: [{ name: 'KEY', value: 'v' }] },
    { type: 'http', name: 'remote', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
  ])
  assert.deepEqual(created.params._meta, { yoloMode: false, autoMode: false, reasoningEffort: 'low', modelId: 'grok-fast' })
  // Model and effort accompany creation; nothing needs resending afterward.
  assert.equal(rpc.filter((entry) => entry.method === 'session/set_config_option').length, 0)

  assert.deepEqual(f.events.find((event) => event.type === 'session.started'),
    { type: 'session.started', agent: 'grok', agentSessionId: 'ses_fixture', model: 'grok-fast', cwd: f.cwd, tools: [] })
  await until(() => f.count('commands.updated') > 0 && f.count('mcp.updated') > 1)
  assert.deepEqual(f.events.filter((event) => event.type === 'mcp.updated').at(-1)?.servers, [
    { name: 'secretless', state: 'failed', tools: [], error: 'Missing secret: X', external: false },
    { name: 'declared', state: 'connected', tools: [], error: null, external: false },
  ])
})

test('reprise par session/resume, mode « tout autoriser » et consignes du dépôt masquées', async (t) => {
  const f = await runnerFixture(t, {
    config: { ...DEFAULT_GROK_CONFIG, permissionMode: 'bypassPermissions' }, resumeSessionId: 'ses_old',
    maskedInstructionRoots: () => ['/repo'], projectOverview: () => 'OVERVIEW',
  })
  const rpc = await f.rpc()
  const resumed = rpc.find((entry) => entry.method === 'session/resume')!
  assert.equal(resumed.params.sessionId, 'ses_old')
  assert.equal(resumed.params._meta.yoloMode, true)
  assert.deepEqual(resumed.params._meta.agentProfile, { name: 'sillage', description: 'Sillage session', agentsMd: false })
  assert.equal(resumed.params.additionalDirectories, undefined, 'session/resume refuse les répertoires supplémentaires')
  assert.equal(resumed.params._meta.rules, undefined, 'le prompt système enregistré avec la session vaut à la reprise')
  assert.ok(!rpc.some((entry) => entry.method === 'session/new'))
})

test('permission : la décision devient l’option de Grok du même genre', async (t) => {
  const f = await runnerFixture(t)
  const options = [
    { optionId: 'allow-edits-session', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
  ]
  const toolCall = { toolCallId: 'c1', kind: 'edit', title: 'Edit `a.txt`', rawInput: { variant: 'SearchReplace', file_path: 'a.txt', old_string: 'a', new_string: 'b' }, _meta: tool('search_replace', 'edit') }
  await f.play({ steps: [{ permission: { toolCall, options } }, { permission: { toolCall, options } }, { permission: { toolCall, options } }] })

  const decisions = [
    { decision: 'allowed' as const, scope: 'once' as const },
    { decision: 'allowed' as const, scope: 'session' as const },
    { decision: 'denied' as const, scope: 'once' as const },
  ]
  for (const [index, decision] of decisions.entries()) {
    await until(() => f.events.filter((event) => event.type === 'permission.requested').length > index, 'permission')
    const request = f.events.filter((event) => event.type === 'permission.requested')[index]!
    assert.ok(request.type === 'permission.requested')
    assert.equal(request.toolName, 'Edit')
    assert.equal(request.title, 'Edit `a.txt`')
    assert.ok(f.runner.resolvePermission(request.requestId, { ...decision, decidedBy: 'me' }))
  }
  await until(() => f.count('turn.completed') > 0)
  const answers = (await f.rpc()).filter((entry) => entry.answer).map((entry) => entry.answer!.result.outcome)
  assert.deepEqual(answers, [
    { outcome: 'selected', optionId: 'allow-once' },
    { outcome: 'selected', optionId: 'allow-edits-session' },
    { outcome: 'selected', optionId: 'reject-once' },
  ])
})

test('interruption : session/cancel, tour clos en « interrupted », demande en attente expirée', async (t) => {
  const f = await runnerFixture(t)
  await f.play({ steps: [{ update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run_terminal_command', rawInput: { command: 'sleep 9' }, _meta: tool('run_terminal_command', 'execute') } }, { wait: 3000 }] })
  await until(() => f.count('tool.started') > 0)
  await f.runner.interrupt()
  await until(() => f.count('turn.completed') > 0)
  assert.ok((await f.rpc()).some((entry) => entry.method === 'session/cancel'))
  const done = f.events.find((event) => event.type === 'turn.completed')
  assert.equal(done?.type === 'turn.completed' && done.stopReason, 'interrupted')
  assert.deepEqual(f.events.find((event) => event.type === 'tool.completed'),
    { type: 'tool.completed', toolCallId: 'c1', output: 'Tool execution aborted', isError: true, durationMs: (f.events.find((event) => event.type === 'tool.completed') as { durationMs: number }).durationMs })
})

test('modèle, effort et mode de permission se changent à chaud ; les outils web demandent une relance', async (t) => {
  const f = await runnerFixture(t)
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_GROK_CONFIG, model: 'grok-fast', reasoningEffort: 'low' }), true)
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_GROK_CONFIG, model: 'grok-fast', reasoningEffort: 'low', permissionMode: 'bypassPermissions' }), true)
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_GROK_CONFIG, model: 'grok-fast', reasoningEffort: 'low', permissionMode: 'plan' }), true)
  const rpc = await f.rpc()
  assert.deepEqual(rpc.filter((entry) => entry.method === 'session/set_config_option').map((entry) => [entry.params.configId, entry.params.value]),
    [['model', 'grok-fast'], ['reasoning_effort', 'low']])
  assert.deepEqual(rpc.filter((entry) => entry.method === '_x.ai/yolo_mode_changed').map((entry) => entry.params),
    [{ yolo_mode: true, auto_mode: false }, { yolo_mode: false, auto_mode: false }])
  assert.deepEqual(rpc.filter((entry) => entry.method === 'session/set_mode').map((entry) => entry.params.modeId), ['plan'])
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_GROK_CONFIG, webSearch: false }), false)
  assert.equal(await f.runner.applyConfig({ ...DEFAULT_GROK_CONFIG, account: 'autre' }), false, 'le compte est le home du process')
})

test('le texte de projet part en règles à la création de la session, pas dans les messages', async (t) => {
  const f = await runnerFixture(t, { projectOverview: () => 'OVERVIEW' })
  await f.turn({ steps: [] })
  const rpc = await f.rpc()
  assert.equal(rpc.find((entry) => entry.method === 'session/new')!.params._meta.rules, 'OVERVIEW')
  const prompt = rpc.find((entry) => entry.method === 'session/prompt')!.params.prompt
  assert.ok(!prompt.some((block: { text?: string }) => block.text === 'OVERVIEW'))
})

test('question de l’agent : réponses rendues par intitulé de question', async (t) => {
  const f = await runnerFixture(t)
  await f.play({ steps: [{ request: { method: '_x.ai/ask_user_question', params: { toolCallId: 'c1', mode: 'default', questions: [
    { question: 'Chats ou chiens ?', options: [{ label: 'Chats', description: 'Les chats' }, { label: 'Chiens', description: 'Les chiens' }], multiSelect: null },
  ] } } }] })
  await until(() => f.count('question.requested') > 0)
  const asked = f.events.find((event) => event.type === 'question.requested')!
  assert.ok(asked.type === 'question.requested')
  assert.deepEqual(asked.questions[0], {
    id: 'Chats ou chiens ?', header: '', question: 'Chats ou chiens ?', multiSelect: false, allowOther: true, secret: false,
    options: [{ label: 'Chats', description: 'Les chats', preview: null }, { label: 'Chiens', description: 'Les chiens', preview: null }],
  })
  assert.ok(f.runner.answerQuestion(asked.requestId, { status: 'answered', answers: { 'Chats ou chiens ?': ['Chats'] }, decidedBy: 'me' }))
  await until(() => f.count('turn.completed') > 0)
  const answer = (await f.rpc()).find((entry) => entry.answer)!.answer!
  assert.deepEqual(answer.result, { outcome: 'accepted', answers: { 'Chats ou chiens ?': ['Chats'] } })
})

test('plan soumis : validé avec la suite « laisser décider », le mode suit', async (t) => {
  const updates: unknown[] = []
  const f = await runnerFixture(t, { config: { ...DEFAULT_GROK_CONFIG, permissionMode: 'plan' }, updateConfig: (config) => updates.push(config) })
  assert.deepEqual((await f.rpc()).filter((entry) => entry.method === 'session/set_mode').map((entry) => entry.params.modeId), ['plan'])
  await f.play({ steps: [{ request: { method: '_x.ai/exit_plan_mode', params: { toolCallId: 'c1', planContent: '# Plan\n1. Faire' } } },
    { update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } }] })
  await until(() => f.count('plan.review_requested') > 0)
  const review = f.events.find((event) => event.type === 'plan.review_requested')!
  assert.ok(review.type === 'plan.review_requested')
  assert.equal(review.plan, '# Plan\n1. Faire')
  assert.deepEqual(review.followUpOptions.map((option) => option.id), ['default', 'auto'])
  assert.ok(f.runner.reviewPlan(review.requestId, { decision: 'approved', followUpMode: 'auto', decidedBy: 'me' }))
  await until(() => f.count('turn.completed') > 0)
  const rpc = await f.rpc()
  assert.deepEqual(rpc.find((entry) => entry.answer)!.answer!.result, { outcome: 'approved' })
  assert.deepEqual(rpc.filter((entry) => entry.method === '_x.ai/yolo_mode_changed').map((entry) => entry.params), [{ yolo_mode: false, auto_mode: true }])
  assert.equal((f.runner.appliedConfig as typeof DEFAULT_GROK_CONFIG).permissionMode, 'auto')
  assert.equal((updates.at(-1) as typeof DEFAULT_GROK_CONFIG).permissionMode, 'auto')
})

test('steer par _x.ai/interject, compaction par _x.ai/compact_conversation', async (t) => {
  const f = await runnerFixture(t)
  assert.equal(await f.runner.steer('Hors tour', [], [], []), false, 'sans tour en cours, rien à infléchir')
  await f.play({ steps: [{ wait: 300 }] })
  assert.equal(await f.runner.steer('Aussi ceci', [], [], []), true)
  await until(() => f.count('turn.completed') > 0)
  const rpc = await f.rpc()
  assert.deepEqual(rpc.find((entry) => entry.method === '_x.ai/interject')!.params, { sessionId: 'ses_fixture', text: 'Aussi ceci' })

  assert.equal(await f.runner.compact(), true)
  await until(() => f.count('context.compacted') > 0)
  assert.deepEqual(f.events.find((event) => event.type === 'context.compacted'),
    { type: 'context.compacted', trigger: 'manual', preTokens: 900, postTokens: 300 })
  assert.equal(f.count('context.compaction_started'), 1)
})


test('ACP title, location, late MCP identity and pre-completion output survive independent updates', async (t) => {
  const f = await runnerFixture(t)
  await f.turn({ steps: [
    update({ sessionUpdate: 'tool_call', toolCallId: 'late', title: 'use_tool', rawInput: {}, _meta: tool('use_tool', 'use_tool') }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'late', title: 'Read the project card', rawInput: { tool_name: 'sillage__read_card', tool_input: { number: 3 } } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'late', locations: [{ path: 'src/a.ts', line: 3 }], rawOutput: { type: 'MCP', output: { OkayOutput: 'Card body' } } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'late', status: 'completed' }),
    update({ sessionUpdate: 'tool_call', toolCallId: 'text', title: 'Reading source', rawInput: {} }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'text', name: 'read_file', title: 'Read the entry point', rawInput: { target_file: 'src/main.ts' }, content: [{ type: 'content', content: { type: 'text', text: 'Source content' } }] }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'text', status: 'completed' }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'text', status: 'completed' }),
  ] })
  assert.equal(f.events.filter(event => event.type === 'tool.started').length, 2, 'A repeated completion must not recreate the tool')
  const updates = f.events.filter(event => event.type === 'tool.input_updated')
  const last = updates.filter(event => event.toolCallId === 'late').at(-1)!
  assert.equal(last.name, 'sillage/read_card')
  assert.deepEqual(last.input, { number: 3 })
  assert.deepEqual(last.presentation, { title: 'Read the project card', paths: ['src/a.ts'] })
  assert.equal(updates.find(event => event.toolCallId === 'text')?.name, 'Read')
  assert.deepEqual(f.events.filter(event => event.type === 'tool.completed').map(event => event.output), ['Card body', 'Source content'])
  for (const event of f.events) sillageEventSchema.parse(event)
})
