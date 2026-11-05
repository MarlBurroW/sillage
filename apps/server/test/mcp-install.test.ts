import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { conversations, mcpServers, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { DEFAULT_CLAUDE_CONFIG, parseAgentConfig } from '@sillage/protocol'
import type { AgentRegistry } from '../src/agents/registry.js'
import { answerMcpInstall, mcpServerNameClash, pendingMcpInstall } from '../src/agents/mcp-install.js'
import { resolveMcpServers } from '../src/agents/mcp-registry.js'
import type { Config } from '../src/config.js'
import { EventLog } from '../src/events/event-log.js'
import { SecretStore } from '../src/secrets/store.js'
import { AgentRequests } from '../src/sessions/agent-requests.js'
import type { SessionManager } from '../src/sessions/session-manager.js'

/**
 * Agent-proposed MCP servers: the tool posts a form in the conversation, the answer stores
 * secrets and creates the entry, and project scope reaches only the project's conversations.
 */
async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-mcp-install-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())

  db.insert(users).values({ id: 'owner', username: 'owner', displayName: 'owner', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'project', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'other', name: 'other', workspacePath: dir, ownerId: 'owner', visibility: 'private', createdAt: 1 }).run()
  const conversation = (id: string, projectId: string | null = 'project') =>
    db.insert(conversations).values({
      id, projectId, userId: 'owner', title: `Session ${id}`, agent: 'claude', config: JSON.stringify(DEFAULT_CLAUDE_CONFIG), status: 'running',
      createdAt: 1, updatedAt: Date.now(),
    }).run()

  const sent: { to: string; text: string }[] = []
  const reloaded: string[] = []
  const sessions = {
    statusBus: new EventEmitter(),
    async sendMessage(to: string, _id: string, text: string) { sent.push({ to, text }) },
    async reloadConfig(id: string) { reloaded.push(id) },
    notifyRequest() {},
  } as unknown as SessionManager
  const log = new EventLog(db)
  const secrets = new SecretStore(db, randomBytes(32))
  const requests = new AgentRequests({ db, config: {} as Config }, sessions, {} as AgentRegistry, undefined, undefined, undefined, undefined, log)

  const mcp = async (from: string, name: string, args: object) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'project', SILLAGE_MCP_CONVERSATION: from },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    const deadline = Date.now() + 10000
    while (!stdout.includes('\n') && Date.now() < deadline) {
      await requests.sweep()
      await new Promise((done) => setTimeout(done, 50))
    }
    child.kill()
    return JSON.parse(stdout).result as { content: { text: string }[]; isError?: boolean }
  }

  return { db, dbPath, log, secrets, sessions, sent, reloaded, conversation, mcp }
}

/** Rights are the route's concern (`scope-rule.test.ts`); here only secret replacement differs. */
const ADMIN = { id: 'owner', canReplaceSecrets: true }
const OWNER = { id: 'owner', canReplaceSecrets: false }

const github = {
  name: 'github',
  transport: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {{secret.GITHUB_TOKEN}}' } },
  purpose: 'Read issues and pull requests of this repository.',
  secret_hints: { GITHUB_TOKEN: 'github.com/settings/tokens' },
}

test('a proposal is posted as an editable form, refused in clear text, and one at a time', async (t) => {
  const { log, conversation, mcp } = await harness(t)
  conversation('self')

  const clear = await mcp('self', 'install_mcp_server', { ...github, transport: { type: 'http', url: github.transport.url, headers: { Authorization: 'Bearer ghp_real_token' } } })
  assert.equal(clear.isError, true)
  assert.match(clear.content[0]!.text, /credentials written in clear/)
  assert.equal(pendingMcpInstall(log, 'self'), null)

  const posted = await mcp('self', 'install_mcp_server', github)
  assert.equal(posted.isError, undefined, posted.content[0]?.text)
  assert.match(posted.content[0]!.text, /shown to the user.*GITHUB_TOKEN/)
  const pending = pendingMcpInstall(log, 'self')
  assert.ok(pending)
  assert.equal(pending.name, 'github')
  assert.equal(pending.scope, 'project')
  assert.deepEqual(pending.secretHints, { GITHUB_TOKEN: 'github.com/settings/tokens' })
  assert.deepEqual(pending.transport, { type: 'http', url: github.transport.url, headers: github.transport.headers })

  const twice = await mcp('self', 'install_mcp_server', { ...github, name: 'github2' })
  assert.equal(twice.isError, true)
  assert.match(twice.content[0]!.text, /already waiting/)

  const listed = await mcp('self', 'list_mcp_servers', {})
  assert.match(listed.content[0]!.text, /No MCP server is declared/)
})

test('installing stores the typed secret, scopes the server and tells the agent', async (t) => {
  const { db, dbPath, log, secrets, sessions, sent, reloaded, conversation, mcp } = await harness(t)
  conversation('self')
  conversation('sibling')
  conversation('elsewhere', 'other')
  await mcp('self', 'install_mcp_server', github)
  const pending = pendingMcpInstall(log, 'self')!
  const row = db.select().from(conversations).where(eq(conversations.id, 'self')).get()!

  // A value is required for a secret the store lacks.
  await assert.rejects(
    answerMcpInstall({ db, log, secrets, sessions }, row, pending, { decision: 'installed', name: 'github', transport: pending.transport, scope: 'project', secrets: {} }, ADMIN),
    { code: 'mcp_install_secret_missing', params: { names: 'GITHUB_TOKEN' } },
  )

  const server = await answerMcpInstall(
    { db, log, secrets, sessions }, row, pending,
    // A value for a secret the transport does not reference is not stored.
    { decision: 'installed', name: 'gh', transport: pending.transport, scope: 'project', secrets: { GITHUB_TOKEN: 'ghp_typed_by_user', UNRELATED: 'x' } },
    OWNER,
  )
  assert.equal(secrets.has('UNRELATED'), false)
  assert.ok(server)
  assert.equal(server.name, 'gh')
  assert.equal(server.projectId, 'project')
  assert.equal(secrets.resolve('GITHUB_TOKEN'), 'ghp_typed_by_user')
  assert.equal(pendingMcpInstall(log, 'self'), null)
  assert.deepEqual(reloaded, ['self'])
  assert.match(sent[0]!.text, /“gh” is installed in project scope.*renamed from “github”/)
  // The secret value never reaches the journal.
  const journal = log.read('self', 0, 100).map((entry) => JSON.stringify(entry.event)).join('\n')
  assert.doesNotMatch(journal, /ghp_typed_by_user/)
  assert.match(journal, /mcp_install\.resolved/)

  // Project scope: every conversation of the project, selected or not, and no other project.
  const inProject = resolveMcpServers(db, secrets, [], 'project')
  assert.deepEqual(inProject.servers.map((entry) => entry.name), ['gh'])
  assert.equal(inProject.servers[0]!.transport.type === 'http' ? inProject.servers[0]!.transport.headers.Authorization : '', 'Bearer ghp_typed_by_user')
  assert.deepEqual(resolveMcpServers(db, secrets, [server.id], 'other').servers, [])
  assert.deepEqual(resolveMcpServers(db, secrets, [server.id], null).servers, [])
  // Project servers need no selection in the conversation configuration.
  assert.deepEqual(parseAgentConfig(db.select().from(conversations).where(eq(conversations.id, 'self')).get()!.config).mcpServers, [])

  const listed = await mcp('self', 'list_mcp_servers', {})
  assert.match(listed.content[0]!.text, /gh \(this project, http, active in this session\)/)
  assert.match(listed.content[0]!.text, /Authorization=Bearer \{\{secret\.GITHUB_TOKEN\}\}/)
  assert.doesNotMatch(listed.content[0]!.text, /ghp_typed_by_user/)
  const elsewhere = await (async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
      env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'other', SILLAGE_MCP_CONVERSATION: 'elsewhere' },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_mcp_servers', arguments: {} } }) + '\n')
    const deadline = Date.now() + 10000
    while (!stdout.includes('\n') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
    child.kill()
    return JSON.parse(stdout).result as { content: { text: string }[] }
  })()
  assert.match(elsewhere.content[0]!.text, /No MCP server is declared/)

  // Names are unique across what one conversation receives: another project may reuse “gh”, a
  // global server may not, and this project may not take a global name.
  assert.equal(mcpServerNameClash(db, 'gh', 'other'), null)
  assert.equal(mcpServerNameClash(db, 'gh', 'project'), 'taken')
  assert.equal(mcpServerNameClash(db, 'gh', null), 'taken')
  assert.equal(mcpServerNameClash(db, 'gh', 'project', server.id), null)
  assert.equal(mcpServerNameClash(db, 'sillage', 'other'), 'reserved')

  // A deleted project takes its servers with it: nothing else would ever reach them.
  db.update(conversations).set({ projectId: 'other' }).where(eq(conversations.projectId, 'project')).run()
  db.delete(projects).where(eq(projects.id, 'project')).run()
  assert.equal(db.select().from(mcpServers).where(eq(mcpServers.id, server.id)).get(), undefined)
})

test('a global installation is selected in the requesting conversation and declining just tells the agent', async (t) => {
  const { db, log, secrets, sessions, sent, conversation, mcp } = await harness(t)
  conversation('self')
  await mcp('self', 'install_mcp_server', { name: 'files', transport: { type: 'stdio', command: 'npx', args: ['-y', 'files-mcp'], env: { ROOT: '/srv' } }, scope: 'global' })
  const row = db.select().from(conversations).where(eq(conversations.id, 'self')).get()!
  const pending = pendingMcpInstall(log, 'self')!
  assert.equal(pending.scope, 'global')

  const server = await answerMcpInstall({ db, log, secrets, sessions }, row, pending, { decision: 'installed', name: 'files', transport: pending.transport, scope: 'global', secrets: {} }, ADMIN)
  assert.ok(server)
  assert.equal(server.projectId, null)
  assert.deepEqual(parseAgentConfig(db.select().from(conversations).where(eq(conversations.id, 'self')).get()!.config).mcpServers, [server.id])
  assert.equal(db.select().from(mcpServers).all().length, 1)

  // A global name is taken for every project.
  const dup = await mcp('self', 'install_mcp_server', { name: 'files', transport: { type: 'stdio', command: 'x' } })
  assert.equal(dup.isError, true)
  assert.match(dup.content[0]!.text, /already exists/)
  assert.equal(mcpServerNameClash(db, 'files', 'other'), 'taken')

  await mcp('self', 'install_mcp_server', { name: 'slack', transport: { type: 'http', url: 'https://mcp.slack.com', headers: { 'X-Token': '{{secret.SLACK}}' } } })
  const slack = pendingMcpInstall(log, 'self')!
  // Someone who is not an administrator adds a missing secret, but never replaces a stored one.
  secrets.put('SLACK', 'stored-by-admin')
  const install = { decision: 'installed' as const, name: 'slack', transport: slack.transport, scope: 'project' as const }
  await assert.rejects(
    answerMcpInstall({ db, log, secrets, sessions }, row, slack, { ...install, secrets: { SLACK: 'overwrite' } }, OWNER),
    { code: 'mcp_install_secret_exists', statusCode: 403 },
  )
  assert.equal(secrets.resolve('SLACK'), 'stored-by-admin')
  assert.equal(db.select().from(mcpServers).all().length, 1)
  secrets.delete('SLACK')

  const declined = await answerMcpInstall({ db, log, secrets, sessions }, row, slack, { decision: 'declined' }, OWNER)
  assert.equal(declined, null)
  assert.equal(db.select().from(mcpServers).all().length, 1)
  assert.equal(secrets.resolve('SLACK'), undefined)
  assert.match(sent.at(-1)!.text, /declined installing “slack”/)
})
