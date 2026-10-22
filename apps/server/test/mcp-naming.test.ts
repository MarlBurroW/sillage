import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CODEX_CONFIG, type McpServer } from '@sillage/protocol'
import { builtinMcpServer } from '../src/agents/mcp-builtin.js'
import { toCodexThreadConfig } from '../src/agents/codex/mcp.js'

test('Codex pre-authorizes only the built-in session naming tool', () => {
  const builtin = builtinMcpServer({ enabled: true, config: DEFAULT_CODEX_CONFIG, databasePath: '/tmp/test.sqlite', projectId: 'project', conversationId: 'self', memoryDir: null })!
  const thirdParty: McpServer = { ...builtin, id: 'external', name: 'external' }
  const overrides = toCodexThreadConfig([builtin, thirdParty]).mcp_servers as Record<string, Record<string, unknown>>
  assert.deepEqual(overrides.sillage!.tools, { rename_session: { approval_mode: 'approve' } })
  assert.equal(overrides.external!.tools, undefined)
  assert.equal(overrides.sillage!.default_tools_approval_mode, undefined)
  assert.deepEqual(toCodexThreadConfig([]), { mcp_servers: {} })
  assert.equal(builtinMcpServer({ enabled: true, config: { ...DEFAULT_CODEX_CONFIG, sillageMcp: false }, databasePath: '/tmp/test.sqlite', projectId: 'project', conversationId: 'self', memoryDir: null }), null)
})
