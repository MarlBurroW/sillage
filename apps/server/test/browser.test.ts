import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDatabase, runMigrations } from '@sillage/db'
import { BROWSER_MCP_SERVER_NAME, PLAYWRIGHT_MCP_PACKAGE, PLAYWRIGHT_MCP_VERSION } from '@sillage/protocol'
import { BrowserManager } from '../src/browser/manager.js'
import type { Config } from '../src/config.js'

/** End-to-end behavior (launch, proxy, live view, takeover) is covered by `scripts/agent-browser-check.mjs`. */
test('sessions get the browser server only once installed, with a per-conversation token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-browser-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.sqlite'))
  t.after(() => sqlite.close())
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  const previous = process.env.SILLAGE_BROWSER_EXECUTABLE
  process.env.SILLAGE_BROWSER_EXECUTABLE = process.execPath
  t.after(() => {
    if (previous === undefined) delete process.env.SILLAGE_BROWSER_EXECUTABLE
    else process.env.SILLAGE_BROWSER_EXECUTABLE = previous
  })
  const config = { paths: { data: dir }, server: { host: '0.0.0.0', port: 7400 } } as unknown as Config
  const browsers = new BrowserManager(db, config)
  t.after(() => browsers.shutdown())

  assert.equal(browsers.mcpServerFor('c1'), null, 'no MCP server before installation')

  const pkg = join(dir, 'browser', 'mcp', 'node_modules', PLAYWRIGHT_MCP_PACKAGE)
  await mkdir(pkg, { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ version: PLAYWRIGHT_MCP_VERSION }))
  await writeFile(join(pkg, 'cli.js'), '')
  assert.equal(browsers.install.status().ready, true)

  const server = browsers.mcpServerFor('c1')
  assert.equal(server?.name, BROWSER_MCP_SERVER_NAME)
  const args = server?.transport.type === 'stdio' ? server.transport.args : []
  const endpoint = args[args.indexOf('--cdp-endpoint') + 1] ?? ''
  // A wildcard listener is reached on loopback.
  assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:7400\/api\/browser-cdp\/c1\?token=[0-9a-f]{64}$/)

  const token = browsers.tokenFor('c1')
  assert.equal(browsers.verify('c1', token), true)
  assert.equal(browsers.verify('c2', token), false, 'a token opens one conversation only')
  assert.equal(browsers.verify('c1', 'short'), false)
  // Stable across daemon restarts: the key lives in the data directory.
  assert.equal(new BrowserManager(db, config).tokenFor('c1'), token)
})
