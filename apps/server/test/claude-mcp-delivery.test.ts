import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { DEFAULT_CLAUDE_CONFIG, type ClaudeConfig, type McpServer, type SillageEvent } from '@sillage/protocol'
import { BUNDLED_CLAUDE_CODE_VERSION, mcpServersDelivery } from '../src/agents/claude/mcp-delivery.js'
import { ClaudeRunner } from '../src/agents/claude/runner.js'
import type { RunnerContext } from '../src/agents/types.js'

/** MCP secrets off the command line (SDK 0.3.326+), effective permission mode and relayed steering (2.1.332), card #83. */

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Fixture did not respond')
}

const SECRET = 'fixture-secret-token'
const server: McpServer = {
  id: 'registry', name: 'registry', enabled: true, projectId: null,
  transport: { type: 'stdio', command: 'node', args: ['server.mjs'], env: { API_TOKEN: SECRET } },
  createdAt: 0, updatedAt: 0,
}
const init = { type: 'system', subtype: 'init', uuid: 'u-init', session_id: 'fixture-session', permissionMode: 'default', cwd: '/', tools: [], model: 'x', mcp_servers: [], slash_commands: [] }

async function setup(t: TestContext, options: { cliVersion?: string | null; env?: Record<string, string>; idle?: unknown[] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'sillage-claude-delivery-'))
  const traceFile = join(cwd, 'trace.jsonl')
  const events: SillageEvent[] = []
  const config: ClaudeConfig = { ...DEFAULT_CLAUDE_CONFIG, permissionMode: 'manual' }
  const ctx: RunnerContext = {
    conversationId: 'test', cwd, config, resumeSessionId: null, attachmentsRoot: cwd,
    binary: fileURLToPath(new URL('./fixtures/claude-agent.mjs', import.meta.url)),
    processEnv: { CLAUDE_FIXTURE_TRACE: traceFile, CLAUDE_FIXTURE_IDLE_EVENTS: JSON.stringify(options.idle ?? []), ...options.env },
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [server], failures: [] }), skillRoots: () => [],
    emit: (event) => events.push(event), setStatus: () => {}, setAgentSessionId: () => {},
    updateConfig: () => {}, openPermissionRequest: () => 'permission', closePermissionRequest: () => {},
  }
  const runner = new ClaudeRunner(ctx, (model) => model, async () => options.cliVersion ?? null)
  t.after(async () => { await runner.stop(); await rm(cwd, { recursive: true, force: true }) })
  await runner.start()
  const trace = async (): Promise<Record<string, any>[]> => (await readFile(traceFile, 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  await waitFor(async () => (await trace()).find((message) => message.request?.subtype === 'mcp_status'))
  return { runner, config, events, trace }
}

test('the initialize delivery needs a CLI at least as new as the one the SDK bundles', () => {
  assert.match(BUNDLED_CLAUDE_CODE_VERSION ?? '', /^\d+\.\d+\.\d+$/)
  assert.equal(mcpServersDelivery('2.1.332', '2.1.332'), 'initialize')
  assert.equal(mcpServersDelivery('2.2.0', '2.1.332'), 'initialize')
  assert.equal(mcpServersDelivery('2.1.318', '2.1.332'), 'argv')
  // Unknown or unreadable versions keep the command line, which every CLI accepts.
  assert.equal(mcpServersDelivery(null, '2.1.332'), 'argv')
  assert.equal(mcpServersDelivery('2.1.400-beta', '2.1.332'), 'argv')
  assert.equal(mcpServersDelivery('2.1.400', null), 'argv')
})

test('a recent CLI receives MCP servers over stdin, never on its command line', async (t) => {
  const f = await setup(t, { cliVersion: '9.0.0', env: { CLAUDE_FIXTURE_MCP_APPLIED: 'true' } })
  const messages = await f.trace()
  const launch = messages.find((message) => message.type === 'launch')
  assert.ok(launch)
  assert.equal(launch.args.some((arg: string) => arg.includes(SECRET)), false)
  assert.equal(launch.args.includes('--mcp-config'), false)
  const initialize = messages.find((message) => message.request?.subtype === 'initialize')
  assert.equal(JSON.stringify(initialize?.request).includes(SECRET), true)
})

test('an older or unknown CLI keeps the command line, explicitly', async (t) => {
  const f = await setup(t, { cliVersion: '2.1.318' })
  const launch = (await f.trace()).find((message) => message.type === 'launch')
  assert.ok(launch?.args.includes('--mcp-config'))
})

test('servers sent at initialize but not applied are reported in the conversation', async (t) => {
  // An absent field ends the session in the SDK itself; an explicit false is Sillage's to report.
  const f = await setup(t, { cliVersion: '9.0.0', env: { CLAUDE_FIXTURE_MCP_APPLIED: 'false' }, idle: [init] })
  const notice = await waitFor(async () => f.events.find((event) => event.type === 'agent.notice' && event.code === 'claude_mcp_servers_not_applied'))
  assert.ok(notice)
})

test('applied servers raise no notice', async (t) => {
  const f = await setup(t, { cliVersion: '9.0.0', env: { CLAUDE_FIXTURE_MCP_APPLIED: 'true' }, idle: [init] })
  // The init message is sent after mcp_status; leave the check time to run.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(f.events.some((event) => event.type === 'agent.notice' && event.code === 'claude_mcp_servers_not_applied'), false)
})

test('a live mode change the CLI adjusts is reported with the mode in effect', async (t) => {
  const f = await setup(t, { env: { CLAUDE_FIXTURE_EFFECTIVE_MODE: 'default' } })
  assert.equal(await f.runner.applyConfig({ ...f.config, permissionMode: 'auto' }), true)
  const notice = f.events.find((event) => event.type === 'agent.notice' && event.code === 'claude_permission_mode_adjusted')
  assert.ok(notice?.type === 'agent.notice')
  assert.deepEqual(notice.details, { requested: 'auto', actual: 'default' })
})

test('untrusted steering is marked synthetic, the user\'s own is not', async (t) => {
  const f = await setup(t)
  // A scenario with no events keeps the turn open, as a working agent would.
  await f.runner.send(JSON.stringify({ events: [] }), [], [], [])
  // The fixture reads every user message as a scenario: steered texts are empty ones too.
  assert.equal(await f.runner.steer(JSON.stringify({ events: [], from: 'user' }), [], [], []), true)
  assert.equal(await f.runner.steer(JSON.stringify({ events: [], from: 'github' }), [], [], [], { untrusted: true }), true)
  const steered = await waitFor(async () => {
    const found = (await f.trace()).filter((message) => message.type === 'user' && message.priority === 'next')
    return found.length === 2 ? found : undefined
  })
  assert.equal(steered[0]?.isSynthetic, undefined)
  assert.equal(steered[1]?.isSynthetic, true)
})

test('the CLI is asked for thinking summaries, not the empty blocks SDK sessions get by default', async (t) => {
  // Card #128: without the flag, 92 % of thinking blocks in production carried no text.
  const f = await setup(t)
  const launch = (await f.trace()).find((message) => message.type === 'launch')
  const index = launch?.args.indexOf('--thinking-display') ?? -1
  assert.notEqual(index, -1)
  assert.equal(launch?.args[index + 1], 'summarized')
  // The thinking type stays the model's own: Haiku 4.5 has no adaptive thinking.
  assert.equal(launch?.args.some((arg: string) => arg.startsWith('--thinking=')), false)
})
