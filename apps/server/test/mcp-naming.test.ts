import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CODEX_CONFIG, isReservedMcpServerName, type McpServer } from '@sillage/protocol'
import { builtinMcpServer } from '../src/agents/mcp-builtin.js'
import { fromCodexMcpStatus, toCodexThreadConfig } from '../src/agents/codex/mcp.js'

test('Codex pre-authorizes only the built-in session naming tool', () => {
  const builtin = builtinMcpServer({ enabled: true, config: DEFAULT_CODEX_CONFIG, databasePath: '/tmp/test.sqlite', projectId: 'project', conversationId: 'self', memoryDir: null })!
  const thirdParty: McpServer = { ...builtin, id: 'external', name: 'external' }
  const overrides = toCodexThreadConfig([builtin, thirdParty]).mcp_servers as Record<string, Record<string, unknown>>
  assert.deepEqual(overrides.sillage_builtin!.tools, { rename_session: { approval_mode: 'approve' } })
  assert.equal(overrides.sillage, undefined)
  assert.equal(overrides.external!.tools, undefined)
  assert.equal(overrides.sillage_builtin!.default_tools_approval_mode, undefined)
  assert.deepEqual(toCodexThreadConfig([]), { mcp_servers: {} })
  assert.equal(builtinMcpServer({ enabled: true, config: { ...DEFAULT_CODEX_CONFIG, sillageMcp: false }, databasePath: '/tmp/test.sqlite', projectId: 'project', conversationId: 'self', memoryDir: null }), null)
})

test('Codex keeps user HTTP servers separate from its built-in transport and inventory', () => {
  const builtin = builtinMcpServer({ enabled: true, config: DEFAULT_CODEX_CONFIG, databasePath: '/tmp/test.sqlite', projectId: 'project', conversationId: 'self', memoryDir: null })!
  const http: McpServer = { ...builtin, id: 'user-http', name: 'sillage', transport: { type: 'http', url: 'https://example.invalid/mcp', headers: {} } }
  const overrides = toCodexThreadConfig([builtin, http]).mcp_servers as Record<string, Record<string, unknown>>
  assert.equal(overrides.sillage!.url, 'https://example.invalid/mcp')
  assert.equal(overrides.sillage!.command, undefined)
  assert.equal(overrides.sillage_builtin!.url, undefined)
  assert.equal(overrides.sillage_builtin!.command, process.execPath)
  assert.equal(isReservedMcpServerName('SILLAGE_BUILTIN'), true)
  const statuses = fromCodexMcpStatus([
    { name: 'sillage_builtin', authStatus: 'unsupported', tools: {}, resources: [], resourceTemplates: [] },
    { name: 'sillage', authStatus: 'unsupported', tools: {}, resources: [], resourceTemplates: [] },
  ], [builtin], new Map([['sillage_builtin', { status: 'ready', error: null }]]))
  assert.deepEqual(statuses.map(({ name, state, external }) => ({ name, state, external })), [
    { name: 'sillage_builtin', state: 'connected', external: false },
    { name: 'sillage', state: 'connected', external: true },
  ])
})
