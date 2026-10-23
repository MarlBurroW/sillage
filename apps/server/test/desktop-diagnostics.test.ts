import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DiagnosticLog, diagnosticRecord } from '../../desktop/src/diagnostic-log.js'
import { parseProcessMemory, sumProcessTree, sampleProcessTree } from '../../desktop/src/process-memory.js'

test('diagnostics whitelist numeric facts, rotate during use and survive a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-diagnostics-test-'))
  try {
    const file = join(dir, 'performance.jsonl')
    const log = new DiagnosticLog(file)
    assert.equal(diagnosticRecord('private prompt', { ms: 1 }), null)
    for (let i = 0; i < 6000; i++) log.add('thread-ready', { ms: i, bytes: 100, content: 'secret', path: '/private', cursor: Infinity, heapBytes: NaN })
    assert.equal(log.snapshot().length, 300)
    for (const name of [file, `${file}.1`]) {
      assert.ok(statSync(name).size < 257 * 1024)
      assert.ok(!readFileSync(name, 'utf8').includes('secret'))
    }
    const restored = new DiagnosticLog(file)
    assert.deepEqual(restored.snapshot(), log.snapshot())
    assert.deepEqual(restored.snapshot().at(-1)?.metrics, { ms: 5999, bytes: 100 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('OS memory parsers keep only numbers and count the server tree once', async () => {
  const rows = parseProcessMemory('30 20 3\n10 1 10\n20 10 2\n40 1 100\ninvalid', false)
  assert.deepEqual(sumProcessTree(rows, 10), { serverRssBytes: 10240, cliAndToolsRssBytes: 5120, cliAndToolsCount: 2 })
  const windows = parseProcessMemory(JSON.stringify([
    { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: '10240', CommandLine: 'private' },
    { ProcessId: 20, ParentProcessId: 10, WorkingSetSize: '2048' },
  ]), true)
  assert.deepEqual(sumProcessTree(windows, 10), { serverRssBytes: 10240, cliAndToolsRssBytes: 2048, cliAndToolsCount: 1 })
  const live = await sampleProcessTree(process.pid)
  assert.ok(live.serverRssBytes! > 0)
})
