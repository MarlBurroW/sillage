import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_CLAUDE_CONFIG, sillageEventSchema, type ClaudeConfig, type McpServer, type SillageEvent } from '@sillage/protocol'
import { ClaudeRunner } from '../src/agents/claude/runner.js'
import type { RunnerContext } from '../src/agents/types.js'

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Fixture did not respond')
}

const server: McpServer = {
  id: 'registry', name: 'registry', enabled: true, projectId: null,
  transport: { type: 'stdio', command: 'node', args: ['server.mjs'], env: {} },
  createdAt: 0, updatedAt: 0,
}

async function setup(t: TestContext, initial: McpServer[] = [], resumeSessionId: string | null = null, idleEvents: unknown[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'sillage-claude-live-'))
  const traceFile = join(cwd, 'trace.jsonl')
  const events: SillageEvent[] = []
  let servers = initial
  const config: ClaudeConfig = { ...DEFAULT_CLAUDE_CONFIG, permissionMode: 'manual' }
  const ctx: RunnerContext = {
    conversationId: 'test', cwd, config, resumeSessionId, attachmentsRoot: cwd,
    binary: fileURLToPath(new URL('./fixtures/claude-agent.mjs', import.meta.url)),
    processEnv: { CLAUDE_FIXTURE_TRACE: traceFile, CLAUDE_FIXTURE_IDLE_EVENTS: JSON.stringify(idleEvents) },
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers, failures: [] }), skillRoots: () => [],
    emit: (event) => events.push(event), setStatus: () => {}, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => 'permission', closePermissionRequest: () => {},
  }
  const runner = new ClaudeRunner(ctx)
  t.after(async () => { await runner.stop(); await rm(cwd, { recursive: true, force: true }) })
  await runner.start()
  const trace = async (): Promise<Record<string, any>[]> => (await readFile(traceFile, 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  await waitFor(async () => (await trace()).find((message) => message.request?.subtype === 'mcp_status'))
  return { runner, config, events, trace, setServers: (next: McpServer[]) => { servers = next } }
}

for (const resume of [null, '00000000-0000-4000-8000-000000000001']) {
  test(`removing a launch MCP requires restart before any live mutation (resume=${Boolean(resume)})`, async (t) => {
    const f = await setup(t, [server], resume)
    f.setServers([])
    assert.equal(await f.runner.applyConfig({ ...f.config, model: 'sonnet' }), false)
    assert.deepEqual(f.runner.appliedConfig, f.config)
    assert.equal((await f.trace()).some((message) => ['set_model', 'mcp_set_servers'].includes(message.request?.subtype)), false)
  })
}

test('MCP additions, updates and removal of a dynamically added server stay live', async (t) => {
  const f = await setup(t)
  f.setServers([server])
  assert.equal(await f.runner.applyConfig(f.config), true)
  f.setServers([{ ...server, transport: { ...server.transport, args: ['changed.mjs'] } } as McpServer])
  assert.equal(await f.runner.applyConfig(f.config), true)
  f.setServers([])
  assert.equal(await f.runner.applyConfig(f.config), true)
  const mutations = (await f.trace()).filter((message) => message.request?.subtype === 'mcp_set_servers')
  assert.equal(mutations.length, 3)
  assert.deepEqual(mutations.at(-1)?.request.servers, {})
})

test('a rejected flag update propagates and does not claim the config was applied', async (t) => {
  const f = await setup(t)
  await assert.rejects(f.runner.applyConfig({ ...f.config, outputStyle: 'fixture-reject' }), /Invalid flag settings/)
  assert.deepEqual(f.runner.appliedConfig, f.config)
})

const updates: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir:*' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['/example'], destination: 'userSettings' },
]

for (const scenario of [
  { name: 'native suggestions', suggestions: updates, scope: 'session' as const, session: true },
  { name: 'once leaves rules unchanged', suggestions: updates, scope: 'once' as const, session: true },
  { name: 'no suggestions', suggestions: [], scope: 'once' as const, session: false },
  { name: 'suppressed suggestions', suggestions: updates, suppressAlwaysAllowRule: true, scope: 'once' as const, session: false },
  { name: 'mode switches need the composer', suggestions: [...updates, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }], scope: 'once' as const, session: false },
]) {
  test(`permission options match native capability: ${scenario.name}`, async (t) => {
    const f = await setup(t)
    await f.runner.send(JSON.stringify(scenario), [], [], [])
    const request = await waitFor(async () => f.events.find((event) => event.type === 'permission.requested'))
    assert.equal(request.type, 'permission.requested')
    if (request.type !== 'permission.requested') return
    assert.equal(request.title, 'Create example directory')
    assert.equal(request.suggestions.some((option) => option.scope === 'session'), scenario.session)
    assert.equal(request.suggestions.some((option) => option.scope === 'always'), false)
    f.runner.resolvePermission(request.requestId, { decision: 'allowed', scope: scenario.scope, decidedBy: 'user' })
    const reply = await waitFor(async () => (await f.trace()).find((message) => message.type === 'control_response'))
    assert.equal(reply.response.response.behavior, 'allow')
    assert.deepEqual(reply.response.response.updatedPermissions,
      scenario.scope === 'session' ? updates.map((update) => ({ ...update, destination: 'session' })) : undefined)
  })
}

test('idle compaction keeps its native trigger without opening a turn', async (t) => {
  const f = await setup(t, [], null, [
    { type: 'system', subtype: 'status', status: 'compacting', uuid: 'status', session_id: 'session' },
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'idle', pre_tokens: 240000 }, uuid: 'compact', session_id: 'session' },
  ])
  const compacted = await waitFor(async () => f.events.find((event) => event.type === 'context.compacted'))
  assert.deepEqual(compacted, { type: 'context.compacted', trigger: 'idle', preTokens: 240000, postTokens: null })
  sillageEventSchema.parse(compacted)
  assert.equal(f.events.filter((event) => event.type === 'turn.started').length, 0)
})
