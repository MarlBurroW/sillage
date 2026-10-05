import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { agentProcessEnv } from '../src/agents/process-env.js'

test('les commandes des agents ne reçoivent pas le NODE_ENV du serveur', (t) => {
  const previous = process.env.NODE_ENV
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  })
  process.env.NODE_ENV = 'production'

  const env = agentProcessEnv({ SILLAGE_TEST_ORIGIN: 'conversation' })
  const child = JSON.parse(execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify({ mode: process.env.NODE_ENV ?? null, origin: process.env.SILLAGE_TEST_ORIGIN, path: process.env.PATH }))',
  ], { env, encoding: 'utf8' }))
  assert.equal(child.mode, null)
  assert.equal(child.origin, 'conversation')
  assert.equal(child.path, process.env.PATH)
  assert.equal(process.env.NODE_ENV, 'production')
  assert.equal(agentProcessEnv({ NODE_ENV: 'test' }).NODE_ENV, 'test')
})
