import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cardIssues, cards, conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { DEFAULT_CLAUDE_CONFIG, disabledSillageTools, resolveAgentTools } from '@sillage/protocol'
import { builtinMcpServer } from '../src/agents/mcp-builtin.js'
import { liveSessionContext, projectOverview, toolsGuidance } from '../src/agents/overview.js'
import { agentToolsFor, familyTableForMcp, sessionFamilies } from '../src/agents/agent-tools.js'
import type { Config } from '../src/config.js'

const ALL = resolveAgentTools({}, null)

test('the tool guidance names each enabled family, and always-on tools whatever the families', () => {
  assert.equal(toolsGuidance({}), 'The `sillage` server tools provide further context: `search_history` and `read_conversation` for earlier decisions, `list_sessions` and `find_file_edits` for current work by others, `work_log` for time spent per day, `send_session_message` to alert or ask another session when it cannot wait for the user, `notify_when_done` to resume when it finishes instead of polling, `broadcast_session_message` before an action affecting all working sessions, `list_cards` and `read_card` for planned project work, `attach_card` when you start on a card this session is not attached to, `create_card` to record work outside your scope, `start_session` to delegate work to a new session when the user asks, `list_worktrees`, `create_worktree` and `remove_worktree` to work separately from others and clean up after a merge instead of using `git worktree add` or `remove`, which Sillage would not track, `schedule_task` to schedule recurring or deferred work that survives this session, `create_automation` to start a session on webhook calls (a labeled issue or failed CI), `list_actions` and `register_action` for project buttons that launch a server, tests or a script, `describe_preview` each time you start a dev server, to title it and name the page to open when it is for the user, or keep an API or worker out of the thread, and `list_mcp_servers` and `install_mcp_server` to propose an MCP server the user confirms, typing any secret themselves.')
  assert.equal(toolsGuidance({ families: { ...ALL, history: false, board: false, coordination: false, automations: false, worktrees: false, actions: false, project: false } }),
    'The `sillage` server tools provide further context: `describe_preview` each time you start a dev server, to title it and name the page to open when it is for the user, or keep an API or worker out of the thread.')
  assert.equal(toolsGuidance({ families: { ...ALL, history: false, board: false, coordination: false, automations: false, worktrees: false, project: false } }),
    'The `sillage` server tools provide further context: `list_actions` and `register_action` for project buttons that launch a server, tests or a script, and `describe_preview` each time you start a dev server, to title it and name the page to open when it is for the user, or keep an API or worker out of the thread.')
})

test('a disabled family leaves the startup context and the server', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-families-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  t.after(() => sqlite.close())
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'u', username: 'u', displayName: 'u', passwordHash: '', isAdmin: true, createdAt: 1 }).run()
  db.insert(projects).values({ id: 'project', name: 'p', workspacePath: dir, ownerId: 'u', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'c', projectId: 'project', userId: 'u', agent: 'claude', title: 't', status: 'idle', config: JSON.stringify(DEFAULT_CLAUDE_CONFIG), createdAt: 1, updatedAt: 1 } as typeof conversations.$inferInsert).run()

  const off = { ...ALL, board: false, coordination: false, project: false }
  const full = projectOverview(db, { projectId: 'project', conversationId: 'c', sillageMcp: true }) ?? ''
  const trimmed = projectOverview(db, { projectId: 'project', conversationId: 'c', sillageMcp: true, families: off }) ?? ''
  for (const tool of ['list_cards', 'move_session', 'attach_project_folder', 'start_session', 'install_mcp_server']) {
    assert.match(full, new RegExp(tool))
    assert.doesNotMatch(trimmed, new RegExp(tool), tool)
  }
  assert.match(trimmed, /search_history/)

  // The daemon hands the server the disabled tools; the server hides them and refuses calls.
  const server = builtinMcpServer({ enabled: true, config: DEFAULT_CLAUDE_CONFIG, databasePath: dbPath, projectId: 'project', conversationId: 'c', memoryDir: null, disabledTools: disabledSillageTools(off) })
  const env = server?.transport.type === 'stdio' ? server.transport.env : {}
  assert.ok(env.SILLAGE_MCP_TOOLS_OFF?.includes('create_card'))
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000,
    input: [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_card', arguments: { title: 'x' } } },
    ].map((message) => JSON.stringify(message)).join('\n') + '\n',
  })
  assert.equal(run.status, 0, run.stderr)
  const replies = run.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] } })
  const names = replies.find((reply) => reply.id === 1)!.result.tools!.map((tool) => tool.name)
  assert.ok(names.includes('search_history') && names.includes('rename_session'))
  for (const tool of ['create_card', 'start_session', 'set_project_image']) assert.ok(!names.includes(tool), tool)
  const refused = replies.find((reply) => reply.id === 2)!.result
  assert.equal(refused.isError, true)
  assert.match(refused.content![0]!.text, /turned off for this project/)
})

test('the launch context names turned-off families, keeps the card, and maintenance keeps the board', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-families-live-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'test.sqlite')
  const { db, sqlite } = openDatabase(dbPath)
  t.after(() => sqlite.close())
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'u', username: 'u', displayName: 'u', passwordHash: '', isAdmin: true, createdAt: 1 }).run()
  db.insert(projects).values({ id: 'home', name: 'Home', workspacePath: dir, ownerId: 'u', visibility: 'private', agentTools: '{"board":false}', crossProjects: true, createdAt: 1 }).run()
  db.insert(projects).values({ id: 'other', name: 'Other', workspacePath: dir, ownerId: 'u', visibility: 'private', agentTools: '{"history":false}', createdAt: 1 }).run()
  db.insert(cards).values({ id: 'card', projectId: 'home', number: 12, title: 'Login', column: 'in_progress', createdBy: 'u', createdAt: 1, updatedAt: 1 }).run()
  for (const id of ['c', 'previous', 'maintenance']) {
    db.insert(conversations).values({ id, projectId: 'home', userId: 'u', agent: 'claude', title: id, status: 'idle', cardId: 'card', config: JSON.stringify(DEFAULT_CLAUDE_CONFIG), createdAt: 1, updatedAt: 1 } as typeof conversations.$inferInsert).run()
  }
  db.insert(cardIssues).values({ cardId: 'card', projectId: 'home', repo: 'acme/app', number: 4, url: 'https://github.com/acme/app/issues/4', title: 'Login', state: 'open', remoteUpdatedAt: new Date().toISOString(), responderId: 'maintenance' }).run()
  const config = { retention: { autoArchiveDays: 0, autoArchiveSchedule: '0 3 * * *' }, limits: { maxConcurrentSessions: 4 }, server: { publicUrl: '' } } as unknown as Config

  const families = sessionFamilies(db, { id: 'c', projectId: 'home' }, agentToolsFor(db, config, 'home'))
  assert.equal(families?.board, false)
  assert.equal(sessionFamilies(db, { id: 'maintenance', projectId: 'home' }, agentToolsFor(db, config, 'home'))?.board, true, 'an issue session answers through board tools')
  assert.equal(sessionFamilies(db, { id: 'x', projectId: null }, agentToolsFor(db, config, null)), null, 'personal discussions keep every tool')

  const live = liveSessionContext(db, { projectId: 'home', conversationId: 'c', sillageMcp: true, activity: true, families }) ?? ''
  assert.match(live, /turned off: Board \(`list_cards`/)
  assert.match(live, /card #12 “Login”/, 'the card stays as context')
  assert.match(live, /already worked on it/)
  assert.doesNotMatch(live, /Call `read_card`/, "no instruction to use a turned-off tool")

  // Cross-project calls follow the target project's switches.
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))], {
    env: { ...process.env, SILLAGE_MCP_DB: dbPath, SILLAGE_MCP_PROJECT: 'home', SILLAGE_MCP_CONVERSATION: 'c', SILLAGE_MCP_TOOL_FAMILIES: familyTableForMcp() },
    encoding: 'utf8', timeout: 10000,
    input: [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_history', arguments: { query: 'login', project: 'Other' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_cards', arguments: { project: 'Other' } } },
    ].map((message) => JSON.stringify(message)).join('\n') + '\n',
  })
  assert.equal(run.status, 0, run.stderr)
  const replies = run.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result: { isError?: boolean; content: { text: string }[] } })
  const history = replies.find((reply) => reply.id === 1)!.result
  assert.equal(history.isError, true)
  assert.match(history.content[0]!.text, /turned off in project “Other”/)
  assert.doesNotMatch(replies.find((reply) => reply.id === 2)!.result.content[0]!.text, /turned off/)
})
